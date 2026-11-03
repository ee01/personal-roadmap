<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoadmapState, QUARTER_NONE } from '../composables/useRoadmapState';
import { CURQ, esc, fmtMD, parseDate, qEnd, qStart, today, diffD } from '../composables/useGeometry';
import type { MilestoneValue } from '../types';
import MilestonePopover from './MilestonePopover.vue';
import QuarterPopover from './QuarterPopover.vue';
import CopyExport from './CopyExport.vue';

/**
 * 视图过滤行（原 Quarter 导入栏）。横跨 Backlog 与甘特，只放「影响看什么」的
 * 过滤；Quarter 勾选与导入属于「拉什么数据」，移到了 Backlog 标题旁的「↻ 拉取」。
 * QUARTER / MILESTONE 与文本搜索是 AND，同时作用于 Backlog 与甘特；没有数据时
 * 对应段不显示。
 */
const state = useRoadmapState();
const triggerEl = ref<HTMLElement | null>(null);
const popOpen = ref(false);
const qTriggerEl = ref<HTMLElement | null>(null);
const qPopOpen = ref(false);

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

/* ---------- Quarter 过滤（Target Delivery Quarter） ----------
   当前 + 下一个 Quarter 直接平铺为 chip（一次点击即生效）；完整候选在 ▾ 浮层。 */
function toggleQ(q: string) {
  const sel = state.qSel.value;
  state.setQSel(sel.includes(q) ? sel.filter((k) => k !== q) : [...sel, q]);
}

function qChipTip(q: string): string {
  if (q === QUARTER_NONE) return '未设置 Target Delivery Quarter||单击切换 · 多选 = 命中任一';
  const n = state.qCount(q);
  const over = state.qOverCount(q);
  return `${q}${q === CURQ ? ' · 当前 Quarter' : ''} · ${fmtMD(qStart(q))} → ${fmtMD(qEnd(q))}||${n} 个条目${over ? ' · 有条目的结束日超出该 Quarter' : ''}||单击切换 · 多选 = 命中任一`;
}

function openQPop() {
  qPopOpen.value = true;
}

function closeQPop(refocus?: boolean) {
  qPopOpen.value = false;
  if (refocus) qTriggerEl.value?.focus();
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
      <!-- 层级（E-171）：横跨 Backlog 与甘特的过滤行最左 —— 它同时改变左右两侧的分组，
           与「任务 / 人员 / 依赖」视图正交；切换只是本人的查看偏好 -->
      <div class="tier-filter">
        <span class="ib-label">层级</span>
        <div class="tier-seg" role="group" aria-label="查看层级">
          <button
            type="button"
            :aria-pressed="!state.isInit.value"
            data-tip="Epic 层级||Backlog 按 Quarter 分组，甘特每行一个 Epic"
            @click="state.setHierarchy('epic')"
          >
            <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="4" width="10" height="2.4" rx="1.2" fill="currentColor" /><rect x="2" y="8.2" width="7" height="2.4" rx="1.2" fill="currentColor" opacity=".55" /></svg>Epic</button>
          <button
            type="button"
            :aria-pressed="state.isInit.value"
            data-tip="INIT 层级||按 Epic 的 Parent Link 汇总：INIT → Epic → 子任务||筛选仍按 Epic 判断，INIT 只是父级上下文 · 依赖仍归属原 Epic"
            @click="state.setHierarchy('init')"
          >
            <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 3.2h10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /><path d="M4.5 7h7.5M4.5 10.8h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity=".55" /><path d="M2.6 4.8v6h1.4M2.6 7h1.4" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".55" /></svg>INIT</button>
        </div>
      </div>
      <template v-if="state.hasQData.value">
        <span class="ib-label">QUARTER</span>
        <div class="q-seg" role="group" aria-label="按 Target Delivery Quarter 过滤">
          <button
            v-for="q in state.quickQuarters.value"
            :key="q"
            type="button"
            class="q-chip"
            :class="{ zero: !state.qCount(q), now: q === CURQ }"
            :aria-pressed="state.qSel.value.includes(q)"
            :data-tip="qChipTip(q)"
            @click="toggleQ(q)"
          >
            <template v-if="q === QUARTER_NONE">未设置</template>
            <template v-else><span class="yr">{{ q.slice(0, 5) }}</span>{{ q.slice(5) }}</template>
            <span class="n">{{ state.qCount(q) }}</span>
            <span v-if="state.qOverCount(q)" class="ov" aria-label="有超界条目" />
          </button>
          <button
            ref="qTriggerEl"
            class="q-more"
            :class="{ on: state.qActive.value }"
            type="button"
            aria-haspopup="listbox"
            :aria-expanded="qPopOpen"
            aria-controls="qPop"
            data-tip="全部 Quarter||候选优先来自 Jira「Target Delivery Quarter」字段选项；读不到时按当前 Quarter 前 2 后 1 推算"
            @click="qPopOpen ? closeQPop() : openQPop()"
          >
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
        </div>
        <button
          v-if="state.qActive.value"
          type="button"
          class="q-clear"
          @click="state.setQSel([])"
        >
          清除
        </button>
      </template>
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
        :data-tip="
          state.isInit.value
            ? 'INIT 层级：同一 INIT 下未命中的兄弟 Epic||隐藏（默认）：只看范围内的 Epic，避免误读成同一季度 · 淡化：仅作上下文，不参与计数、汇总条与复制||Backlog 始终只列出匹配条目'
            : '甘特中未匹配的条目||淡化：保留排期上下文，便于看清前后挤占 · 隐藏：只看相关条目||Backlog 始终只列出匹配条目'
        "
      >
        <span>其余</span>
        <button
          type="button"
          :class="{ on: state.dimMode.value === 'dim' }"
          @click="state.isInit.value ? state.setInitMode('dim') : state.setMsMode('dim')"
        >
          淡化
        </button>
        <button
          type="button"
          :class="{ on: state.dimMode.value === 'hide' }"
          @click="state.isInit.value ? state.setInitMode('hide') : state.setMsMode('hide')"
        >
          隐藏
        </button>
      </div>
      <!-- 过滤行最右：复制导出。「看到什么就复制什么」，范围跟随当前视图（任务 → Epic / 人员 → 按人分组的 Task）与过滤 -->
      <div class="filter-tail">
        <span v-if="state.filterActive.value" class="ms-stat">
          {{ state.msStats.value.hits }} 项 · 已排期 {{ state.msStats.value.scheduled }}
          <template v-if="state.msStats.value.late">
            · <span class="late">{{ state.msStats.value.late }} 项晚于 milestone</span>
          </template>
          <template v-if="state.msStats.value.qOver">
            · <span class="late">{{ state.msStats.value.qOver }} 项超出 Quarter</span>
          </template>
          <template v-if="state.msStats.value.uc">
            · <span class="uc">Committed: No ×{{ state.msStats.value.uc }}</span>
          </template>
        </span>
        <CopyExport />
      </div>
    </div>
  </div>
  <MilestonePopover
    v-if="popOpen"
    :trigger-el="triggerEl"
    @close="(refocus?: boolean) => closePop(refocus)"
  />
  <QuarterPopover
    v-if="qPopOpen"
    :trigger-el="qTriggerEl"
    @close="(refocus?: boolean) => closeQPop(refocus)"
  />
</template>
