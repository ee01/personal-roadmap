<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import { esc, fmtMD, parseDate, today, diffD } from '../composables/useGeometry';
import type { MilestoneValue } from '../types';
import MilestonePopover from './MilestonePopover.vue';

/**
 * 视图过滤行（原 Quarter 导入栏）。横跨 Backlog 与甘特，只放「影响看什么」的
 * 过滤；Quarter 勾选与导入属于「拉什么数据」，移到了 Backlog 标题旁的「↻ 拉取」。
 * MILESTONE 与文本搜索是 AND，同时作用于 Backlog 与甘特；没有 Custom Label 数据时
 * 只显示搜索框。
 */
const state = useRoadmapState();
const triggerEl = ref<HTMLElement | null>(null);
const popOpen = ref(false);

const selMilestones = computed(() =>
  state.msSel.value
    .map((key) => state.milestones.value.find((m) => m.key === key))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .sort(
      (a, b) =>
        (a.milestoneDate ? parseDate(a.milestoneDate).getTime() : 9e15) -
        (b.milestoneDate ? parseDate(b.milestoneDate).getTime() : 9e15),
    ),
);

function openPop() {
  popOpen.value = true;
}

function closePop(refocus?: boolean) {
  popOpen.value = false;
  if (refocus) triggerEl.value?.focus();
}

function tokenTip(ms: MilestoneValue) {
  const date = ms.milestoneDate ? parseDate(ms.milestoneDate) : null;
  const rel = date ? relOf(date) : '描述中未识别到日期';
  return `${esc(ms.key)} · ${esc(ms.labelName || '')}||${esc(ms.name)}||${
    date ? `Milestone ${fmtMD(date)} · ${rel}` : rel
  }`;
}

/* ---------- 全局文本过滤 ----------
   「/」在任意非输入位置聚焦搜索框（与 GitHub / Linear 一致）；Esc 先清空，再失焦。 */
const searchEl = ref<HTMLInputElement | null>(null);

function onSearchEsc() {
  if (state.searchQuery.value) state.setSearchQuery('');
  else searchEl.value?.blur();
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
  searchEl.value?.focus();
  searchEl.value?.select();
}

onMounted(() => document.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKeydown));

function relOf(date: Date): string {
  const n = diffD(today, date);
  return n === 0 ? '今天' : n > 0 ? `${n} 天后` : `${-n} 天前`;
}
</script>

<template>
  <div v-if="state.snapshot.value" class="import-bar filter-bar">
    <div class="ms-filter">
      <template v-if="state.hasMsData.value">
        <span class="ib-label">MILESTONE</span>
        <button
          ref="triggerEl"
          class="ms-trigger"
          :class="{ on: state.msActive.value }"
          type="button"
          aria-haspopup="listbox"
          :aria-expanded="popOpen"
          aria-controls="msPop"
          @click="popOpen ? closePop() : openPop()"
        >
          <span class="ms-dia" :class="{ hollow: !state.msActive.value }" aria-hidden="true" />
          <span v-if="state.msActive.value" class="ms-trigger-text">
            已选 <span class="ms-n">{{ state.msSel.value.length }}</span>
          </span>
          <span v-else class="ms-trigger-text">全部</span>
          <svg class="car" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M2 4l4 4 4-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <div class="ms-tokens">
          <span
            v-for="ms in selMilestones.slice(0, 2)"
            :key="ms.key"
            class="ms-tok"
            :data-tip="tokenTip(ms)"
          >
            <b>{{ ms.name }}</b>
            <span class="d" :class="{ unk: !ms.milestoneDate }">
              {{ ms.milestoneDate ? fmtMD(ms.milestoneDate) : '日期?' }}
            </span>
            <button
              type="button"
              class="ms-tok-x"
              :aria-label="`移除 ${ms.name}`"
              :data-k="ms.key"
              @click="state.setMsSel(state.msSel.value.filter((k) => k !== ms.key))"
            >
              ×
            </button>
          </span>
          <span
            v-if="selMilestones.length > 2"
            class="ms-tok more"
            role="button"
            tabindex="0"
            @click="openPop"
          >
            +{{ selMilestones.length - 2 }}
          </span>
        </div>
      </template>
      <label class="fb-search" :class="{ on: state.searchActive.value }">
        <svg class="fb-search-ico" width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M9.2 9.2L12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <input
          ref="searchEl"
          class="fb-search-input"
          type="search"
          :value="state.searchQuery.value"
          placeholder="过滤标题 / Key / Owner…"
          aria-label="过滤 Backlog 与甘特中的条目"
          spellcheck="false"
          @input="state.setSearchQuery(($event.target as HTMLInputElement).value)"
          @keydown.esc.stop="onSearchEsc"
        />
        <kbd v-if="!state.searchQuery.value" class="fb-search-kbd" aria-hidden="true">/</kbd>
        <button
          v-else
          class="fb-search-clear"
          type="button"
          aria-label="清空过滤"
          data-tip="清空过滤"
          @click="state.setSearchQuery('')"
        >
          ×
        </button>
      </label>
      <div
        v-if="state.filterActive.value"
        class="ms-mode"
        role="group"
        aria-label="甘特中未匹配的条目"
        data-tip="甘特中未匹配的条目||淡化：保留排期上下文，便于看清前后挤占 · 隐藏：只看相关条目||Backlog 始终只列出匹配条目"
      >
        <span>其余</span>
        <button
          type="button"
          :class="{ on: state.msMode.value === 'dim' }"
          @click="state.setMsMode('dim')"
        >
          淡化
        </button>
        <button
          type="button"
          :class="{ on: state.msMode.value === 'hide' }"
          @click="state.setMsMode('hide')"
        >
          隐藏
        </button>
      </div>
      <span v-if="state.filterActive.value" class="ms-stat">
        {{ state.msStats.value.hits }} 项 · 已排期 {{ state.msStats.value.scheduled }}
        <template v-if="state.msStats.value.late">
          · <span class="late">{{ state.msStats.value.late }} 项晚于 milestone</span>
        </template>
      </span>
    </div>
  </div>
  <MilestonePopover
    v-if="popOpen"
    :trigger-el="triggerEl"
    @close="(refocus?: boolean) => closePop(refocus)"
  />
</template>
