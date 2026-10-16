<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import { esc, fmtMD, parseDate, today, diffD } from '../composables/useGeometry';
import type { MilestoneValue } from '../types';
import MilestonePopover from './MilestonePopover.vue';

/**
 * 视图过滤行（原 Quarter 导入栏）。横跨 Backlog 与甘特，只放「影响看什么」的
 * 过滤；Quarter 勾选与导入属于「拉什么数据」，移到了 Backlog 标题旁的「↻ 拉取」。
 * 没有任何 Custom Label 数据时整行不显示。
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

function relOf(date: Date): string {
  const n = diffD(today, date);
  return n === 0 ? '今天' : n > 0 ? `${n} 天后` : `${-n} 天前`;
}
</script>

<template>
  <div v-if="state.hasMsData.value" class="import-bar filter-bar">
    <div class="ms-filter">
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
      <div
        v-if="state.msActive.value"
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
      <span v-if="state.msActive.value" class="ms-stat">
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
