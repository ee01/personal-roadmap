<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoadmapState, QUARTER_NONE } from '../composables/useRoadmapState';
import { CURQ, diffD, fmtMD, qEnd, qStart, today } from '../composables/useGeometry';

/**
 * Quarter 多选浮层（Target Delivery Quarter）。完整候选列表：优先来自 Jira
 * 字段选项（经扩展读取并缓存）；读不到时按当前 Quarter 前 2 后 1 回落，条目上
 * 出现的其他值自动补入。每行带条目数与「结束日超出该 Quarter」计数。
 */
const props = defineProps<{ triggerEl: HTMLElement | null }>();
const emit = defineEmits<{ (e: 'close', refocus?: boolean): void }>();

const state = useRoadmapState();
const popEl = ref<HTMLElement | null>(null);
const shown = ref(false);
const kbIndex = ref(-1);
const showZero = ref(false);

const opts = computed(() => {
  const { list, extra, source } = state.qCandidates.value;
  const rows = list.map((q) => ({
    q,
    count: state.qCount(q),
    over: state.qOverCount(q),
    extra: extra.includes(q),
  }));
  const live = rows.filter((r) => r.count || state.qSel.value.includes(r.q));
  const zero = rows.filter((r) => !(r.count || state.qSel.value.includes(r.q)));
  return { live, zero, source };
});

const showZeroRows = computed(() => showZero.value || !opts.value.live.length);

function isNone(q: string) {
  return q === QUARTER_NONE;
}

function subText(q: string, extra: boolean): string {
  if (isNone(q)) return '手动条目 / Jira 未填';
  return `${fmtMD(qStart(q))} → ${fmtMD(qEnd(q))}${extra ? ' · 仅见于条目' : ''}`;
}

function tipOf(q: string, over: number): string {
  if (isNone(q)) return '未设置 Target Delivery Quarter||手动创建或 Jira 未填的条目';
  const rel = diffD(today, qEnd(q));
  return `${q}${q === CURQ ? ' · 当前 Quarter' : ''} · ${fmtMD(qStart(q))} → ${fmtMD(qEnd(q))}||${
    rel >= 0 ? `${rel} 天后结束` : `${-rel} 天前已结束`}${over ? ` · ${over} 个条目的结束日超出该 Quarter` : ''}||多选 = 命中任一`;
}

function toggle(q: string) {
  const sel = state.qSel.value;
  state.setQSel(sel.includes(q) ? sel.filter((k) => k !== q) : [...sel, q]);
}

const optElements = () =>
  popEl.value
    ? ([...popEl.value.querySelectorAll<HTMLElement>('.q-opt')] as HTMLElement[])
    : [];

function onOptionClick(q: string) {
  kbIndex.value = opts.value.live.findIndex((r) => r.q === q);
  toggle(q);
}

function onListKeydown(ev: KeyboardEvent) {
  const els = optElements();
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!els.length) return;
    kbIndex.value =
      (kbIndex.value + (ev.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length;
    els.forEach((el, i) => el.classList.toggle('kb', i === kbIndex.value));
    els[kbIndex.value].scrollIntoView({ block: 'nearest' });
  } else if (ev.key === 'Enter' && kbIndex.value >= 0 && els[kbIndex.value]) {
    ev.preventDefault();
    toggle(els[kbIndex.value].dataset.q || '');
  }
}

function updatedAgo(): string {
  const ms = state.qOptFetchedAt.value;
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

/* ---------- 定位 / 打开关闭 ---------- */
function place() {
  const pop = popEl.value;
  if (!pop || !props.triggerEl) return;
  const r = props.triggerEl.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 356))}px`;
}

function onResize() {
  if (popEl.value) place();
}

function onOutsidePointerDown(ev: PointerEvent) {
  const target = ev.target as HTMLElement | null;
  if (target?.closest('.q-pop, .q-more')) return;
  emit('close');
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    ev.stopPropagation();
    emit('close', true);
  }
}

function refreshOptions() {
  void state.syncQuarterOptions({ force: true });
}

watch(
  () => state.qSel.value.length,
  () => {
    kbIndex.value = -1;
  },
);

onMounted(() => {
  place();
  window.addEventListener('resize', onResize);
  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
  requestAnimationFrame(() => {
    shown.value = true;
    const first = optElements()[0];
    first?.focus({ preventScroll: true });
  });
  // 打开浮层时后台刷新一次字段选项（超过 6 小时才真正请求）
  void state.syncQuarterOptions();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div ref="popEl" class="q-pop" :class="{ show: shown }" role="dialog" aria-label="按 Target Delivery Quarter 过滤">
    <div class="q-src">
      <div class="k">候选来源 · <b>Target Delivery Quarter</b></div>
      <span v-if="opts.source === 'jira'" class="st">
        <i />Jira 字段选项 · {{ state.qCandidates.value.list.length }} 个<template v-if="updatedAgo()"> · 更新于 {{ updatedAgo() }}</template>
      </span>
      <span v-else class="st fb">
        <i />未能读取 Jira 字段选项 · 已回落
      </span>
      <p v-if="opts.source === 'fallback'">
        按当前 Quarter <b>{{ CURQ }}</b> 往前 2 个、往后 1 个推算；条目上出现的其他值会自动补入。
        装有扩展并登录 Jira 后可读取字段选项（<button type="button" class="q-retry" :disabled="state.qOptSyncing.value" @click="refreshOptions">重试</button>）。
      </p>
    </div>
    <div class="q-list" role="listbox" aria-multiselectable="true" @keydown="onListKeydown">
      <template v-if="opts.live.length">
        <div class="q-sec">当前团队有条目</div>
        <button
          v-for="r in opts.live"
          :key="r.q"
          type="button"
          class="q-opt"
          :class="{ zero: !r.count, past: !isNone(r.q) && r.q < CURQ }"
          role="option"
          :aria-selected="state.qSel.value.includes(r.q)"
          :data-q="r.q"
          :data-tip="tipOf(r.q, r.over)"
          @click="onOptionClick(r.q)"
        >
          <span class="box">
            <svg width="10" height="10" viewBox="0 0 12 12">
              <path
                d="M2.5 6.2l2.4 2.4 4.6-5"
                fill="none"
                stroke="#fff"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <span style="min-width: 0">
            <div class="nm">{{ isNone(r.q) ? '未设置' : r.q }}<em v-if="r.q === CURQ">当前</em></div>
            <div class="sub">{{ subText(r.q, r.extra) }}</div>
          </span>
          <span class="rt">
            {{ r.count }} 项
            <template v-if="r.over"><br /><span class="ov">{{ r.over }} 项超出</span></template>
          </span>
        </button>
      </template>
      <template v-if="opts.zero.length">
        <div v-if="showZeroRows" class="q-sec">无条目</div>
        <button
          v-for="r in (showZeroRows ? opts.zero : [])"
          :key="`z-${r.q}`"
          type="button"
          class="q-opt zero"
          role="option"
          :aria-selected="state.qSel.value.includes(r.q)"
          :data-q="r.q"
          :data-tip="tipOf(r.q, r.over)"
          @click="toggle(r.q)"
        >
          <span class="box">
            <svg width="10" height="10" viewBox="0 0 12 12">
              <path
                d="M2.5 6.2l2.4 2.4 4.6-5"
                fill="none"
                stroke="#fff"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <span style="min-width: 0">
            <div class="nm">{{ isNone(r.q) ? '未设置' : r.q }}</div>
            <div class="sub">{{ subText(r.q, r.extra) }}</div>
          </span>
          <span class="rt">{{ r.count }} 项</span>
        </button>
        <button
          v-if="!showZeroRows"
          type="button"
          class="q-show-more"
          @click="showZero = true"
        >
          显示其余 {{ opts.zero.length }} 个（当前团队无条目）
        </button>
      </template>
    </div>
    <div class="q-foot">
      <span class="hint">多选 = 命中任一 · <kbd>↑</kbd><kbd>↓</kbd> 移动 <kbd>Enter</kbd> 勾选 <kbd>Esc</kbd> 关闭</span>
      <button type="button" class="clr" :disabled="!state.qSel.value.length" @click="state.setQSel([])">
        清除
      </button>
      <button type="button" class="btn btn-primary done" @click="emit('close', true)">完成</button>
    </div>
  </div>
</template>
