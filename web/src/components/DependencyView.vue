<script setup lang="ts">
import { computed, nextTick, onMounted, onUpdated, ref, watch } from 'vue';
import { useRoadmapState, INIT_NONE, initKeyOf } from '../composables/useRoadmapState';
import {
  addD,
  clamp,
  dateMs,
  diffD,
  fmtISO,
  fmtMD,
  today,
} from '../composables/useGeometry';
import {
  defaultDependencyNeed,
  dependencyDrift,
  dependencyGap,
  dependencyGroups,
  dependencyState,
  snapDependencyNeed,
  type DependencyState,
} from '../composables/dependency';
import { bridgeFetchDependencyDates } from '../composables/useExtensionBridge';
import {
  nudgeDependency,
  openDepPopover,
  refreshDependencyEta,
  type MarkerHandlers,
} from '../composables/useMarkerFloats';
import {
  epicColor,
  epicShort,
  itemDisplayKey,
  jiraBrowseUrl,
} from '../composables/useRoadmapContract';
import { LOCATE_SVG } from '../composables/ganttLocate';
import type { RoadmapItem, RoadmapMarker } from '../types';

/**
 * 依赖视图：只列出带外部依赖的任务，完整展示 ETA / 期望 / 差距 / Ticket 排期。
 * 排版、样式、交互一比一对应 docs/demo/roadmap-demo.html 的 renderDeps / dvRowHtml：
 * - 左侧按主任务分组（组头 + 淡色任务排期条），组内 / 组间按风险排序；
 * - 右侧时间轴自适应宽度（百分比定位，不横向滚动），范围 = 相关日期 ± 留白；
 * - 拖动 ETA 点或期望环 = 改期望（±1 天吸附回 ETA），单击 = 打开依赖浮层改 / 刷新 ETA；
 * - 行内 hover 操作：刷新 ETA / 催一下 / 接受 ETA / 填写 ETA。
 */
const state = useRoadmapState();
const host = ref<HTMLElement>();

const items = computed(() => state.scheduledItems.value.filter(state.viewMatch));
const allGroups = computed(() => dependencyGroups(items.value, 'all'));
const rows = computed(() => dependencyGroups(items.value, state.dependencyFilter.value));
const allDeps = computed(() => allGroups.value.flatMap((g) => g.deps));
const nLate = computed(() => allDeps.value.filter((d) => dependencyState(d) === 'late').length);
const orderedKeys = computed(() => state.scheduledItems.value.map((it) => it.key));

const itemEnd = (it: RoadmapItem) => addD(it.start!, (it.days || 1) - 1);
const needOf = (it: RoadmapItem, d: RoadmapMarker) => d.need || d.date || defaultDependencyNeed(it);

/* ---------- 时间范围：任务排期 + ETA + 期望 + Ticket 排期 + 今天 ---------- */
const range = computed(() => {
  const ms: number[] = [dateMs(today)];
  for (const { item, deps } of allGroups.value) {
    if (item.start) ms.push(dateMs(item.start), dateMs(itemEnd(item)));
    for (const d of deps)
      for (const x of [d.date, d.need, d.jiraTargetStart, d.jiraTargetEnd]) if (x) ms.push(dateMs(x));
  }
  const s = addD(new Date(Math.min(...ms)), -3);
  let e = addD(new Date(Math.max(...ms)), 4);
  if (diffD(s, e) < 42) e = addD(s, 42);
  return { s, e, N: diffD(s, e) + 1 };
});
const pct = (d: Date | string) => `${(((diffD(range.value.s, d) + 0.5) / range.value.N) * 100).toFixed(3)}%`;
const pctL = (d: Date | string) => `${((diffD(range.value.s, d) / range.value.N) * 100).toFixed(3)}%`;
const widthPct = (days: number) => `${((days / range.value.N) * 100).toFixed(3)}%`;
const clampD = (d: string) => {
  const { s, e } = range.value;
  return dateMs(d) < dateMs(s) ? fmtISO(s) : dateMs(d) > dateMs(e) ? fmtISO(e) : d;
};

/* 表头：月份行在上（月初；首个不足一周的残月不标），周一日期在下（今天 ±2 天让位给「今天」） */
const axis = computed(() => {
  const { s, N } = range.value;
  const months: Array<{ left: string; text: string }> = [];
  const days: Array<{ left: string; text: string }> = [];
  const grid: Array<{ left: string; m: boolean }> = [];
  for (let i = 0; i < N; i++) {
    const d = addD(s, i);
    const m1 = d.getDate() === 1;
    const restOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate();
    if (m1 || (i === 0 && restOfMonth >= 7))
      months.push({
        left: pctL(d),
        text: `${d.getFullYear() !== today.getFullYear() ? `${d.getFullYear()}-` : ''}${d.getMonth() + 1} 月`,
      });
    if (d.getDay() === 1 && Math.abs(diffD(today, d)) > 2) days.push({ left: pctL(d), text: fmtMD(d) });
    if (d.getDay() === 1 || m1) grid.push({ left: pctL(d), m: m1 });
  }
  return { months, days, grid };
});

/* ---------- 状态文案 ---------- */
function stLabel(d: RoadmapMarker): string {
  const st = dependencyState(d);
  const g = dependencyGap(d);
  const L: Record<DependencyState, string> = {
    late: `晚 ${g}d`,
    missing: '缺 ETA',
    stale: 'ETA 待刷新',
    drift: 'Jira 有变更',
    ok: g < 0 ? `余量 ${-g}d` : '按期',
    done: '已交付',
  };
  return L[st];
}
const driftDays = (d: RoadmapMarker) =>
  d.date && d.jiraTargetEnd && dependencyDrift(d) ? diffD(d.date, d.jiraTargetEnd) : 0;
function etaSource(d: RoadmapMarker): string {
  if (!d.date) return '';
  const at = d.etaAt ? ` · ${fmtMD(new Date(d.etaAt))} 读取` : '';
  return d.etaSource === 'jira' ? `ETA 来自 Target End${at}` : `ETA 手动${d.etaAt ? ` · ${fmtMD(new Date(d.etaAt))}` : ''}`;
}
const lateIn = (it: RoadmapItem) => (it.markers || []).filter((m) => m.kind === 'dep' && dependencyState(m) === 'late').length;
const depCount = (it: RoadmapItem) => (it.markers || []).filter((m) => m.kind === 'dep').length;

/* ---------- 层级（E-171）：INIT → Epic → 依赖记录 ----------
   依赖仍归属原 Epic，不指向 INIT；同一目标被多条 Epic 依赖时逐条保留各自期望，
   不合并成一个日期。INIT 组头只汇总、不可拖动。 */
interface DvInitRef {
  item: RoadmapItem;
  d: RoadmapMarker;
  need: string;
  gap: number | null;
}
interface DvInitShared {
  key: string;
  eta: string | null;
  refs: DvInitRef[];
}
interface DvInitHead {
  key: string;
  tickets: number;
  manual: number;
  total: number;
  late: number;
  miss: number;
  stale: number;
  done: number;
  shared: DvInitShared[];
}

function dvInitHead(key: string, groups: Array<{ item: RoadmapItem; deps: RoadmapMarker[] }>): DvInitHead {
  const all = groups.flatMap((g) => g.deps.map((d) => ({ item: g.item, d })));
  const states = all.map((x) => dependencyState(x.d));
  const tickets = new Set(all.filter((x) => x.d.jiraKey).map((x) => x.d.jiraKey!));
  const byKey = new Map<string, DvInitShared>();
  for (const { item, d } of all) {
    if (!d.jiraKey) continue;
    let entry = byKey.get(d.jiraKey);
    if (!entry) {
      entry = { key: d.jiraKey, eta: d.date || null, refs: [] };
      byKey.set(d.jiraKey, entry);
    }
    entry.refs.push({
      item,
      d,
      need: needOf(item, d),
      gap: d.date ? dependencyGap(d) : null,
    });
  }
  const shared = [...byKey.values()].filter((e) => e.refs.length > 1);
  return {
    key,
    tickets: tickets.size,
    manual: all.filter((x) => !x.d.jiraKey).length,
    total: all.length,
    late: states.filter((s) => s === 'late').length,
    miss: states.filter((s) => s === 'missing').length,
    stale: states.filter((s) => s === 'stale').length,
    done: states.filter((s) => s === 'done').length,
    shared,
  };
}

type DepRowOp =
  | { kind: 'init'; id: string; head: DvInitHead }
  | { kind: 'grp'; id: string; item: RoadmapItem; deps: RoadmapMarker[] };

const depRowOps = computed<DepRowOp[]>(() => {
  const grps = rows.value.map((g) => ({ kind: 'grp' as const, id: g.item.key, item: g.item, deps: g.deps }));
  if (!state.isInit.value) return grps;
  const byInit = new Map<string, typeof grps>();
  for (const g of grps) {
    const k = initKeyOf(g.item);
    const list = byInit.get(k);
    if (list) list.push(g);
    else byInit.set(k, [g]);
  }
  const out: DepRowOp[] = [];
  [...byInit.keys()]
    .sort((a, b) => (a === INIT_NONE ? 1 : 0) - (b === INIT_NONE ? 1 : 0))
    .forEach((k) => {
      const list = byInit.get(k)!;
      out.push({
        kind: 'init',
        id: `dvinit:${k}`,
        head: dvInitHead(
          k,
          list.map((g) => ({ item: g.item, deps: g.deps })),
        ),
      });
      out.push(...list);
    });
  return out;
});

/** 同一目标被多条依赖引用时的每个引用：期望 / 差距文案。 */
function sharedRefTip(r: DvInitRef): string {
  const g = r.gap;
  return `${r.item.alias || r.item.title} 期望 ${fmtMD(r.need)}||${
    r.d.date ? (g! > 0 ? `对方 ETA 晚 ${g} 天` : g! < 0 ? `余量 ${-g} 天` : '与 ETA 同日') : '缺 ETA'
  }||两条依赖分属不同 Epic，各自保留期望，不合并`;
}

/** 共享目标的 ETA 文案：各记录 ETA 一致时给日期，否则说明不一致。 */
function sharedEtaText(s: DvInitShared): string {
  const etas = new Set(s.refs.map((r) => r.d.date || ''));
  if (etas.size !== 1) return 'ETA 各记录不一致';
  const eta = [...etas][0];
  return eta ? `ETA ${fmtMD(eta)}` : '缺 ETA';
}

function initKeyTip(key: string): string {
  const info = state.initInfo(key);
  return info.loaded
    ? `${key} · INIT 自身 Quarter ${info.quarter || '未设置'}||${info.title || ''}||INIT 自身的 Quarter 仅作参考，不参与筛选；筛选按子 Epic 的 Target Delivery Quarter`
    : '';
}

function initUcTip(key: string): string {
  return `${key} · Committed: No||${key} 自身的 Committed 字段为 No，且在 ${state.ucScopeText()} 范围内||INIT 行只读 INIT 自身的字段，不从子 Epic 或依赖推导 · 与 Owner 确认是否 commit`;
}

/** INIT 组数（E-171，dv-corner 显示）。 */
const nInits = computed(
  () => new Set(depRowOps.value.filter((o) => o.kind === 'init').map((o) => (o as { head: DvInitHead }).head.key)).size,
);

/* ---------- 浮层 / 写操作 ---------- */
const handlers = computed<MarkerHandlers>(() => ({
  editable: state.editable.value,
  hasExtension: state.hasExtension.value,
  toast: (html) => state.toast(html),
  addMarker: (intent) => state.applySnapshotFromIntent(intent).then(() => undefined),
  updateMarker: (intent) => state.applySnapshotFromIntent(intent).then(() => undefined),
  deleteMarker: (intent) => state.applySnapshotFromIntent(intent).then(() => undefined),
  fetchIssueDates: state.hasExtension.value ? bridgeFetchDependencyDates : undefined,
  jiraBaseUrl: state.snapshot.value?.team.jiraBaseUrl || '',
  showDependency: (id) => {
    state.dependencyFilter.value = 'all';
    state.dependencyFocus.value = id;
  },
}));
const busy = ref<string | null>(null);
async function refresh(it: RoadmapItem, d: RoadmapMarker) {
  busy.value = d.id;
  try {
    await refreshDependencyEta(it, d, handlers.value);
  } finally {
    busy.value = null;
  }
}
function edit(e: Event, it: RoadmapItem, d: RoadmapMarker) {
  openDepPopover(e.currentTarget as HTMLElement, it, handlers.value, d.id);
}
/** 写入期望（null = 跟随 ETA）；成功后提供一次撤销 */
const undo = ref<{ id: string; itemKey: string; need: string | null; version: number } | null>(null);
async function saveNeed(it: RoadmapItem, d: RoadmapMarker, next: string | null, msg?: string) {
  if (!d.date && !next) return;
  if ((next || null) === (d.need || null)) return;
  const prev = d.need || null;
  try {
    await handlers.value.updateMarker({
      op: 'update_marker',
      markerId: d.id,
      itemKey: it.key,
      need: next,
      baseVersion: d.version,
    });
    undo.value = { id: d.id, itemKey: it.key, need: prev, version: d.version + 1 };
    const eff = next || d.date!;
    const g = d.date ? diffD(eff, d.date) : 0;
    state.toast(
      `<span class="ok">✓</span> ${msg || `期望改到 ${fmtMD(eff)}`} · ${
        !d.date ? '缺 ETA' : g > 0 ? `晚 ${g}d` : g < 0 ? `余量 ${-g}d` : '与 ETA 对齐'
      }`,
    );
  } catch {
    /* applySnapshotFromIntent 已提示错误 */
  }
}
async function restore() {
  const u = undo.value;
  if (!u) return;
  undo.value = null;
  try {
    await handlers.value.updateMarker({
      op: 'update_marker',
      markerId: u.id,
      itemKey: u.itemKey,
      need: u.need,
      baseVersion: u.version,
    });
  } catch {
    /* 已提示 */
  }
}
watch(
  () => allDeps.value.find((d) => d.id === undo.value?.id)?.version,
  (v) => {
    if (undo.value && v !== undefined && v !== undo.value.version) undo.value = null;
  },
);

/* ---------- 拖动：按 lane 宽度换算天数；吸附 / 撤销规则与甘特一致 ---------- */
const drag = ref<{ id: string; date: string; snapped: boolean; x: number; y: number } | null>(null);
function onPointDown(e: PointerEvent, it: RoadmapItem, d: RoadmapMarker) {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const tr = el.parentElement!;
  const rect = tr.getBoundingClientRect();
  const origX = e.clientX;
  const { s, N } = range.value;
  let moved = false;
  let cur = needOf(it, d);
  const move = (ev: PointerEvent) => {
    if (!state.editable.value) return;
    if (!moved && Math.abs(ev.clientX - origX) < 3) return;
    moved = true;
    document.body.classList.add('no-select');
    const day = clamp(Math.floor(((ev.clientX - rect.left) / rect.width) * N), 0, N - 1);
    cur = fmtISO(addD(s, day));
    const snapped = Boolean(d.date) && snapDependencyNeed(cur, d.date) === null;
    drag.value = { id: d.id, date: snapped ? d.date! : cur, snapped, x: ev.clientX, y: ev.clientY };
  };
  const end = (commit: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    document.body.classList.remove('no-select');
    drag.value = null;
    if (!commit) return;
    if (!moved) {
      openDepPopover(el, it, handlers.value, d.id);
      return;
    }
    let next = snapDependencyNeed(cur, d.date);
    if (!d.date && !next) next = cur; // 没有 ETA 时期望不能为空
    void saveNeed(it, d, next);
  };
  const up = () => end(true);
  const cancel = () => end(false);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
  window.addEventListener('pointercancel', cancel, { once: true });
}
/* 键盘：← → 改 1 天，Shift 改 7 天，Enter / 空格打开浮层 */
async function onPointKey(e: KeyboardEvent, it: RoadmapItem, d: RoadmapMarker) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openDepPopover(e.currentTarget as HTMLElement, it, handlers.value, d.id);
    return;
  }
  if (!state.editable.value || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  e.preventDefault();
  const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1);
  const date = fmtISO(addD(needOf(it, d), step));
  await saveNeed(it, d, d.date && date === d.date ? null : date);
  await nextTick();
  host.value?.querySelector<HTMLElement>(`.dv-pt.need[data-dep="${d.id}"], .dv-pt.eta[data-dep="${d.id}"]`)?.focus();
}
const dragHintHtml = computed(() => {
  const g = drag.value;
  if (!g) return '';
  const d = allDeps.value.find((x) => x.id === g.id);
  if (!d) return '';
  if (!d.date) return `期望 ${fmtMD(g.date)} · <span class="late">缺 ETA</span>`;
  if (g.snapped) return `期望 ${fmtMD(g.date)} · <span class="ok">与 ETA 对齐</span>`;
  const gap = diffD(g.date, d.date);
  return `期望 ${fmtMD(g.date)} · ${
    gap > 0 ? `<span class="late">晚 ${gap}d</span>` : gap < 0 ? `<span class="ok">余量 ${-gap}d</span>` : '<span class="ok">与 ETA 对齐</span>'
  }`;
});

/* ---------- 单行几何（拖动中用预览期望重算） ---------- */
function geo(it: RoadmapItem, d: RoadmapMarker) {
  const dragging = drag.value?.id === d.id ? drag.value : null;
  const need = dragging ? dragging.date : needOf(it, d);
  const hasNeed = dragging ? true : Boolean(d.need);
  const g = d.date && hasNeed ? diffD(need, d.date) : 0;
  const st = dependencyState(d);
  const dd = driftDays(d);
  return {
    st,
    need,
    g,
    split: Boolean(d.date) && hasNeed && g !== 0,
    dragging: Boolean(dragging),
    drift: dd,
    span:
      d.jiraTargetStart || d.jiraTargetEnd
        ? (() => {
            const ts = clampD(d.jiraTargetStart || d.jiraTargetEnd!);
            const te = clampD(d.jiraTargetEnd || d.jiraTargetStart!);
            return { left: pctL(ts), width: widthPct(diffD(ts, te) + 1) };
          })()
        : null,
  };
}
const bandStyle = (a: string, b: string) => ({ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` });
const midStyle = (a: string, b: string) => ({ left: `calc((${pct(a)} + ${pct(b)}) / 2)` });

/* 带太窄时隐藏「晚 Nd / 余量 Nd」（左侧状态 pill 已有同样信息），避免与日期标签相撞 */
function fitBandLabels() {
  host.value?.querySelectorAll<HTMLElement>('.dv-band').forEach((b) => {
    const l = b.nextElementSibling as HTMLElement | null;
    if (l?.classList.contains('dv-band-l'))
      l.style.display = b.offsetWidth < (b.classList.contains('ok') ? 110 : 52) ? 'none' : '';
  });
}
onUpdated(fitBandLabels);

/* ---------- 从甘特浮层「在依赖视图中查看」跳转：滚动定位 + 闪烁 ---------- */
const flashId = ref<string | null>(null);
async function focusRow() {
  const id = state.dependencyFocus.value;
  if (!id) return;
  await nextTick();
  const row = host.value?.querySelector<HTMLElement>(`.dv-row[data-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({
    block: 'center',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  flashId.value = id;
  state.dependencyFocus.value = null;
  setTimeout(() => {
    if (flashId.value === id) flashId.value = null;
  }, 1700);
}
onMounted(() => {
  fitBandLabels();
  void focusRow();
});
watch(() => state.dependencyFocus.value, focusRow);
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
onMounted(() =>
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitBandLabels, 120);
  }),
);
const emptyFilterText = computed(() =>
  state.dependencyFilter.value === 'late'
    ? '没有晚于期望的依赖'
    : state.dependencyFilter.value === 'missing'
      ? '所有依赖都有 ETA'
      : '没有 Jira 变更待处理',
);
const LINK_ICON =
  '<svg width="18" height="18" viewBox="0 0 14 14"><path d="M6.2 7.8l1.6-1.6M4.3 9.7L2.6 11.4a2 2 0 002.8 2.8l1.7-1.7M9.7 4.3l1.7-1.7a2 2 0 012.8 2.8L12.5 7.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
</script>

<template>
  <div ref="host" class="dep-view">
    <div v-if="!allGroups.length" class="dv-empty">
      <div class="ico" v-html="LINK_ICON" />
      <b>甘特上还没有带外部依赖的任务</b><br />在任务视图 hover 任务条 → 右侧 ◆＋ → 添加外部依赖；<br />填 Jira Key
      会自动读取对方的 Target End 作为 ETA
    </div>
    <template v-else>
      <div class="dv-head">
        <div class="dv-corner">
          <b>{{ allDeps.length }}</b> 个依赖 · <b>{{ allGroups.length }}</b> 个任务<template v-if="state.isInit.value && nInits"> · <b>{{ nInits }}</b> 个 INIT</template><template v-if="nLate">
            · <span class="dv-late-n"><b>{{ nLate }}</b> 个晚于期望</span></template
          >
        </div>
        <div class="dv-axis">
          <div class="dv-tr">
            <div v-for="m in axis.months" :key="`m${m.left}`" class="dv-mon" :style="{ left: m.left }">{{ m.text }}</div>
            <div v-for="t in axis.days" :key="`d${t.left}`" class="dv-tick" :style="{ left: t.left }">{{ t.text }}</div>
            <span class="dv-today-h" :style="{ left: pct(today) }">今天</span>
          </div>
        </div>
      </div>
      <div class="dv-body">
        <div class="dv-grid">
          <div class="dv-tr">
            <div v-for="gl in axis.grid" :key="`g${gl.left}`" class="gl" :class="{ m: gl.m }" :style="{ left: gl.left }" />
            <div class="td" :style="{ left: pct(today) }" />
          </div>
        </div>

        <template v-for="op in depRowOps" :key="op.id">
          <div v-if="op.kind === 'init'" class="dv-init">
            <div class="dvi-info">
              <div class="dvi-top">
                <template v-if="op.head.key !== INIT_NONE">
                  <span class="gi-key" :data-tip="initKeyTip(op.head.key) || undefined">{{ op.head.key }}</span>
                  <span v-if="state.initInfo(op.head.key).loaded && state.initInfo(op.head.key).title" class="gi-title">{{ state.initInfo(op.head.key).title }}</span>
                  <span v-else class="bi-unk" data-tip="INIT 详情未加载||只从 Epic 的 Parent Link 读到 Key；标题、Quarter、Committed 都未拉取||不显示猜测的标题，也不当作完整 INIT">详情未加载</span>
                </template>
                <span v-else class="gi-none">未关联 INIT</span>
                <span v-if="state.initUc(op.head.key)" class="gi-pill uc" :data-tip="initUcTip(op.head.key)"><i />Committed: No</span>
              </div>
              <div class="dvi-sum">
                <span><b>{{ op.head.tickets }}</b> 个目标 Ticket<template v-if="op.head.manual"> + <b>{{ op.head.manual }}</b> 条无 ticket</template></span>
                <span>· <b>{{ op.head.total }}</b> 条依赖</span>
                <span v-if="op.head.late" class="late">· <b>{{ op.head.late }}</b> 条晚于期望</span>
                <span v-if="op.head.miss" class="warn">· <b>{{ op.head.miss }}</b> 缺 ETA</span>
                <span v-if="op.head.stale" class="warn">· <b>{{ op.head.stale }}</b> 待刷新</span>
                <span v-if="op.head.done">· <b>{{ op.head.done }}</b> 已交付</span>
              </div>
            </div>
            <div class="dvi-lane">
              <template v-if="op.head.shared.length">
                <div v-for="s in op.head.shared" :key="s.key" class="dvi-shared">
                  <span
                    class="k"
                    tabindex="0"
                    :data-tip="`${s.key}||${state.depCommittedText(s.refs[0].d)}||同一目标被 ${s.refs.length} 条依赖引用，各自保留期望`"
                  >{{ s.key }}</span>
                  <span class="e">{{ sharedEtaText(s) }}</span>
                  <span>被 {{ s.refs.length }} 条依赖引用：</span>
                  <span
                    v-for="r in s.refs"
                    :key="r.d.id"
                    class="n"
                    :class="{ late: r.gap !== null && r.gap > 0, ok: r.gap !== null && r.gap <= 0 }"
                    :data-tip="sharedRefTip(r)"
                  >{{ epicShort(r.item) }} 期望 {{ fmtMD(r.need) }}<template v-if="r.gap !== null">{{ r.gap > 0 ? ` · 晚 ${r.gap}d` : r.gap < 0 ? ` · 余 ${-r.gap}d` : '' }}</template></span>
                </div>
              </template>
              <span v-else class="dvi-none">组头只汇总、不可拖动 · ETA / 期望请在下方原记录上操作</span>
            </div>
          </div>
          <template v-else>
            <template v-for="{ item: it, deps } in [op]" :key="it.key">
          <div class="dv-grp" :data-item-key="it.key">
            <div class="dv-grp-info">
              <span class="dv-grp-stripe" :style="{ background: epicColor(orderedKeys, it.key) }" />
              <button type="button" class="dv-grp-title dv-locate-title" :title="`在甘特中定位 · ${it.title}`" @click="state.locateInGantt({ itemKey: it.key })">{{ it.alias || it.title }}</button>
              <button type="button" class="dv-locate" aria-label="在甘特中定位主任务" @click="state.locateInGantt({ itemKey: it.key })" v-html="LOCATE_SVG" />
              <span class="dv-grp-meta">{{ itemDisplayKey(it) }} · {{ depCount(it) }} 依赖</span>
              <span v-if="lateIn(it)" class="dv-grp-risk">{{ lateIn(it) }} 晚</span>
            </div>
            <div class="dv-grp-lane">
              <div v-if="it.start" class="dv-tr">
                <span class="dv-task-l" :style="{ left: pctL(it.start) }"
                  >任务排期 {{ fmtMD(it.start) }} → {{ fmtMD(itemEnd(it)) }}</span
                >
                <div
                  class="dv-task"
                  :style="{
                    left: pctL(it.start),
                    width: widthPct(it.days || 1),
                    background: epicColor(orderedKeys, it.key),
                  }"
                />
              </div>
            </div>
          </div>

          <div
            v-for="d in deps"
            :key="d.id"
            class="dv-row"
            :class="{ flash: flashId === d.id }"
            :data-id="d.id"
          >
            <div class="dv-info">
              <div class="dv-top">
                <span class="dep-st" :class="dependencyState(d)">{{ stLabel(d) }}</span>
                <span
                  class="dv-title"
                  role="button"
                  tabindex="0"
                  :data-tip="`单击编辑 Jira ticket / ETA / 期望||${state.depCommittedText(d)}`"
                  @click="edit($event, it, d)"
                  @keydown.enter="edit($event, it, d)"
                  >{{ d.label }}</span
                >
              </div>
              <div class="dv-meta">
                <template v-if="d.jiraKey">
                  <a
                    class="dep-tag jira"
                    :href="jiraBrowseUrl(d.jiraKey, handlers.jiraBaseUrl)"
                    target="_blank"
                    rel="noopener"
                    :data-tip="`${d.jiraKey}${d.jiraStatus ? ' · ' + d.jiraStatus : ''}||${state.depCommittedText(d)}||在 Jira 打开`"
                    >{{ d.jiraKey }}<svg width="8" height="8" viewBox="0 0 14 14"><path d="M6 3H3.5A1.5 1.5 0 002 4.5v6A1.5 1.5 0 003.5 12h6A1.5 1.5 0 0011 10.5V8M8.5 2H12v3.5M12 2L6.8 7.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></a
                  ><span v-if="d.jiraStatus" class="dep-tag status">{{ d.jiraStatus }}</span>
                </template>
                <span v-else class="dep-tag manual">无 ticket</span>
                <span v-if="etaSource(d)">· {{ etaSource(d) }}</span>
              </div>
              <div class="dv-acts">
                <button
                  v-if="undo && undo.id === d.id && state.editable.value"
                  type="button"
                  class="dep-act"
                  @click="restore"
                >
                  撤销
                </button>
                <button
                  v-if="d.jiraKey && dependencyState(d) !== 'done' && state.editable.value"
                  type="button"
                  class="dep-act"
                  :data-tip="`读取 ${d.jiraKey} 的 Target End 写入 ETA`"
                  @click="refresh(it, d)"
                >
                  <span v-if="busy === d.id" class="mini-spin" /><svg
                    v-else
                    width="11"
                    height="11"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M12 7A5 5 0 1 1 10.6 3.6" />
                    <path d="M12 2.2V5H9.2" />
                  </svg>
                  刷新 ETA
                </button>
                <button
                  v-if="['late', 'missing'].includes(dependencyState(d))"
                  type="button"
                  class="dep-act"
                  @click="nudgeDependency(d, handlers)"
                >
                  催一下
                </button>
                <button
                  v-if="dependencyState(d) === 'late' && state.editable.value"
                  type="button"
                  class="dep-act"
                  data-tip="期望改为跟随 ETA（两点合一）"
                  @click="saveNeed(it, d, null, `期望已跟随 ETA ${fmtMD(d.date!)}`)"
                >
                  接受 ETA
                </button>
                <button
                  v-if="state.editable.value"
                  type="button"
                  class="dep-act"
                  @click="edit($event, it, d)"
                >
                  {{ d.jiraKey ? '编辑' : d.date ? '修改 ETA' : '填写 ETA' }}
                </button>
              </div>
            </div>

            <div class="dv-lane">
              <div v-for="gm in [geo(it, d)]" :key="'tr'" class="dv-tr">
                <!-- Ticket 排期（只读镜像） -->
                <template v-if="gm.span">
                  <div
                    class="dv-span"
                    :style="gm.span"
                    :data-tip="`${d.jiraKey} Ticket 排期||Target Start ${d.jiraTargetStart ? fmtMD(d.jiraTargetStart) : '—'} → Target End ${d.jiraTargetEnd ? fmtMD(d.jiraTargetEnd) : '—'}||只读镜像，打开页面时刷新`"
                  />
                  <span class="dv-span-l" :style="{ left: gm.span.left }">{{ d.jiraKey }}</span>
                </template>
                <!-- 期望 ↔ ETA 差距：晚 = 红色半透明带，余量 = 灰色点线 -->
                <template v-if="gm.split">
                  <div
                    class="dv-band"
                    :class="{ ok: gm.g < 0 }"
                    :style="gm.g > 0 ? bandStyle(gm.need, d.date!) : bandStyle(d.date!, gm.need)"
                  />
                  <span
                    class="dv-band-l"
                    :class="{ ok: gm.g < 0 }"
                    :style="gm.g > 0 ? midStyle(gm.need, d.date!) : midStyle(d.date!, gm.need)"
                    >{{ gm.g > 0 ? `晚 ${gm.g}d` : `余量 ${-gm.g}d` }}</span
                  >
                </template>
                <!-- Jira Target End 已变（静默刷新只更新镜像，不自动改 ETA） -->
                <template v-if="d.date && gm.drift && d.jiraTargetEnd">
                  <div
                    class="dv-drift"
                    :class="{ back: gm.drift < 0 }"
                    :style="gm.drift > 0 ? bandStyle(d.date, d.jiraTargetEnd) : bandStyle(d.jiraTargetEnd, d.date)"
                  />
                  <div
                    class="dv-pt ghost"
                    :style="{ left: pct(d.jiraTargetEnd) }"
                    :data-tip="`Jira Target End 已改到 ${fmtMD(d.jiraTargetEnd)}（${gm.drift > 0 ? '+' : ''}${gm.drift}d）||当前 ETA 仍是 ${fmtMD(d.date)}——页面刷新只更新镜像，不自动改 ETA||单击打开 · 点「刷新 ETA」写入`"
                    @click="edit($event, it, d)"
                  />
                  <span class="dv-lbl up drift" :style="{ left: pct(d.jiraTargetEnd) }">Jira {{ fmtMD(d.jiraTargetEnd) }}</span>
                </template>
                <!-- 缺 ETA：期望环后接渐隐虚线 -->
                <div v-if="!d.date" class="dv-tbd" :style="{ left: pct(gm.need) }" />
                <!-- 日期标注：ETA（必标）、期望（下方弱化） -->
                <span
                  v-if="d.date && !gm.split"
                  class="dv-lbl up"
                  :class="{ late: gm.st === 'late' }"
                  :style="{ left: pct(d.date) }"
                  ><small>ETA=期望</small>{{ fmtMD(d.date) }}</span
                >
                <template v-else>
                  <span
                    v-if="d.date"
                    class="dv-lbl up"
                    :class="{ late: gm.g > 0 }"
                    :style="{ left: pct(d.date) }"
                    ><small>ETA</small>{{ fmtMD(d.date) }}</span
                  >
                  <span class="dv-lbl down" :style="{ left: pct(gm.need) }"><small>期望</small>{{ fmtMD(gm.need) }}</span>
                </template>
                <!-- 期望环 -->
                <div
                  v-if="!d.date || gm.split || gm.dragging"
                  class="dv-pt need"
                  :class="{ missing: !d.date, late: gm.g > 0, dragging: gm.dragging }"
                  :data-dep="d.id"
                  tabindex="0"
                  role="slider"
                  :aria-label="`期望日期 ${fmtMD(gm.need)}，左右方向键调整`"
                  :aria-valuetext="gm.need"
                  :style="{ left: pct(gm.need) }"
                  :data-tip="`期望 ${fmtMD(gm.need)}||我们需要对方在这天前交付||拖动或 ← → 调整（Shift 7 天）`"
                  @pointerdown="onPointDown($event, it, d)"
                  @keydown="onPointKey($event, it, d)"
                />
                <!-- ETA 实心点 -->
                <div
                  v-if="d.date"
                  class="dv-pt eta"
                  :class="{ done: gm.st === 'done', late: gm.g > 0 && gm.st !== 'done' }"
                  :data-dep="d.id"
                  tabindex="0"
                  :style="{ left: pct(d.date) }"
                  :data-tip="`ETA ${fmtMD(d.date)}${d.etaSource === 'jira' ? ` · 来自 ${d.jiraKey}` : ' · 手动'}||${state.depCommittedText(d)}||拖动 = 拉出期望（ETA 不动）· 单击 = 刷新 / 修改 ETA`"
                  @pointerdown="onPointDown($event, it, d)"
                  @keydown="onPointKey($event, it, d)"
                />
              </div>
            </div>
          </div>
            </template>
          </template>
        </template>

        <div v-if="!rows.length" class="dv-empty" style="padding: 48px 20px">
          <b>{{ emptyFilterText }}</b><br />切回「全部」查看全部依赖
        </div>
      </div>
    </template>
    <div
      v-if="drag"
      class="dv-hint"
      :style="{ left: `${drag.x + 14}px`, top: `${drag.y - 34}px` }"
      v-html="dragHintHtml"
    />
  </div>
</template>

<style>
/* ============ 依赖视图（对应 demo .dep-view / .dv-*） ============
   视觉语言（与甘特统一）：ETA = 实心点；期望 = 虚线空心环；
   期望早于 ETA → 红色半透明带 + 红线；有余量 → 灰色点线 */
.dep-view {
  --dv-left: 348px;
  --eta: #4a5260;
  --late: #e4573d;
  --late-bg: rgba(228, 87, 61, 0.1);
  --drift: #c9842a;
  --okc: #2e8540;
  flex: 1;
  overflow: auto;
  margin: 0 18px 18px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  position: relative;
}
.dv-head {
  display: grid;
  grid-template-columns: var(--dv-left) 1fr;
  position: sticky;
  top: 0;
  z-index: 8;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(4px);
  border-bottom: 1px solid var(--line);
}
.dv-corner {
  padding: 12px 16px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.dv-corner b {
  font-family: var(--mono);
  color: var(--ink);
}
.dv-corner .dv-late-n,
.dv-corner .dv-late-n b {
  color: #b23a22;
}
.dv-axis {
  position: relative;
  height: 44px;
  border-left: 1px solid var(--line2);
}
.dv-tr {
  position: absolute;
  left: 22px;
  right: 40px;
  top: 0;
  bottom: 0;
}
.dv-mon {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid #d9d6cc;
  padding: 6px 0 0 6px;
  font: 600 10.5px/1 var(--mono);
  color: var(--past-ink);
  white-space: nowrap;
}
.dv-tick {
  position: absolute;
  top: 20px;
  bottom: 0;
  border-left: 1px solid var(--line2);
  padding: 4px 0 0 5px;
  font: 500 10px/1 var(--mono);
  color: var(--muted);
  white-space: nowrap;
}
.dv-today-h {
  position: absolute;
  bottom: 3px;
  transform: translateX(-50%);
  background: var(--danger);
  color: #fff;
  font: 600 9.5px/1 var(--sans);
  letter-spacing: 0.06em;
  border-radius: 4px;
  padding: 3px 6px;
}
.dv-body {
  position: relative;
}
.dv-grid {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--dv-left);
  right: 0;
  pointer-events: none;
  border-left: 1px solid var(--line2);
}
.dv-grid .gl {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(32, 36, 42, 0.04);
}
.dv-grid .gl.m {
  background: var(--line2);
}
.dv-grid .td {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--danger);
  opacity: 0.45;
  transform: translateX(-1px);
}
.dv-grp {
  display: grid;
  grid-template-columns: var(--dv-left) 1fr;
  background: #fbfaf7;
  border-bottom: 1px solid var(--line2);
  position: relative;
}
.dv-grp-info {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  min-width: 0;
}
.dv-grp-stripe {
  width: 4px;
  height: 22px;
  border-radius: 3px;
  flex: none;
}
.dv-grp-title {
  font-size: 12.5px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.dv-grp-meta {
  font: 500 10px var(--mono);
  color: var(--muted);
  flex: none;
}
.dv-grp-risk {
  font: 600 10px var(--sans);
  color: #b23a22;
  background: #fdece8;
  border-radius: 4px;
  padding: 2px 6px;
  flex: none;
}
.dv-grp-lane {
  position: relative;
  min-height: 48px;
}
.dv-task {
  position: absolute;
  top: 30px;
  height: 8px;
  border-radius: 4px;
  opacity: 0.45;
}
.dv-task-l {
  position: absolute;
  top: 12px;
  font: 500 9.5px/1 var(--mono);
  color: var(--muted);
  white-space: nowrap;
}
.dv-row {
  display: grid;
  grid-template-columns: var(--dv-left) 1fr;
  border-bottom: 1px solid var(--line2);
  position: relative;
  transition: background 0.2s;
}
.dv-row:hover {
  background: rgba(32, 36, 42, 0.018);
}
.dv-row.flash {
  animation: dvFlash 1.6s ease;
}
@keyframes dvFlash {
  0%,
  40% {
    background: #eaf3fa;
  }
  100% {
    background: transparent;
  }
}
.dv-info {
  padding: 11px 16px 11px 30px;
  min-width: 0;
  position: relative;
}
.dv-top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.dv-title {
  font-size: 12.5px;
  line-height: 1.4;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-width: 0;
  flex: 1;
  cursor: pointer;
}
.dv-title:hover {
  color: var(--fut-deep);
}
.dv-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
  font-size: 10.5px;
  color: var(--muted);
}
.dv-meta .dep-tag {
  font-size: 9.5px;
}
.dv-acts {
  position: absolute;
  right: 10px;
  bottom: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
  padding-left: 28px;
  background: linear-gradient(90deg, transparent, var(--panel) 24px);
}
.dv-row:hover .dv-acts,
.dv-row:focus-within .dv-acts {
  opacity: 1;
}
.dep-st {
  font: 600 9.5px/1 var(--sans);
  border-radius: 4px;
  padding: 3px 6px;
  flex: none;
  white-space: nowrap;
}
.dep-st.late,
.dep-st.missing {
  background: #fdece8;
  color: #b23a22;
}
.dep-st.stale,
.dep-st.drift {
  background: #fbf1e1;
  color: #8a5a12;
}
.dep-st.ok {
  background: #eef1f4;
  color: #4a5260;
}
.dep-st.done {
  background: #e3f2e9;
  color: #1f5b3c;
}
.dep-act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  font-weight: 600;
  border-radius: 99px;
  padding: 3px 10px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  transition: all 0.13s;
  white-space: nowrap;
}
.dep-act:hover {
  border-color: #c9c6bb;
  background: var(--bg);
}
.dep-act .mini-spin {
  width: 9px;
  height: 9px;
}
.dv-lane {
  position: relative;
  min-height: 76px;
}
/* lane 内部纵向：日期标签(上) / ETA·期望点(28px) / 期望标签(下) / ticket 排期细条(60px) */
.dv-band {
  position: absolute;
  top: 19px;
  height: 18px;
  background: var(--late-bg);
  border-radius: 4px;
  border-top: 2px solid var(--late);
  pointer-events: none;
}
.dv-band.ok {
  background: none;
  border-top: 1.5px dotted #a9b1bb;
  top: 28px;
  height: 0;
}
.dv-band-l {
  position: absolute;
  top: 24px;
  transform: translateX(-50%);
  font: 700 10px/1 var(--mono);
  white-space: nowrap;
  pointer-events: none;
  color: #b23a22;
}
.dv-band-l.ok {
  top: 34px;
  color: var(--okc);
  font-weight: 600;
}
.dv-span {
  position: absolute;
  top: 60px;
  height: 5px;
  border-radius: 3px;
  background: repeating-linear-gradient(-45deg, #c9d3dc 0 3px, #e8edf1 3px 6px);
}
.dv-span-l {
  position: absolute;
  top: 56px;
  transform: translateX(calc(-100% - 6px));
  font: 500 9px var(--mono);
  color: #97a1ac;
  white-space: nowrap;
  pointer-events: none;
}
.dv-pt {
  position: absolute;
  top: 28px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  cursor: grab;
  touch-action: none;
  z-index: 3;
  transition:
    transform 0.15s cubic-bezier(0.2, 0.8, 0.2, 1),
    box-shadow 0.15s;
}
.dv-pt:hover {
  transform: translate(-50%, -50%) scale(1.2);
}
.dv-pt:focus-visible {
  outline: 2px solid var(--fut);
  outline-offset: 2px;
}
.dv-pt.dragging {
  cursor: grabbing;
  transform: translate(-50%, -50%) scale(1.3);
  transition: none;
  z-index: 6;
}
.dv-pt.eta {
  background: var(--eta);
  box-shadow: 0 1px 3px rgba(32, 36, 42, 0.3);
}
.dv-pt.eta.late {
  background: var(--late);
  box-shadow: 0 0 0 3px rgba(228, 87, 61, 0.18);
}
.dv-pt.eta.done {
  background: var(--okc);
}
.dv-pt.eta.done::after {
  content: '';
  position: absolute;
  left: 4.5px;
  top: 3px;
  width: 4px;
  height: 6px;
  border: solid #fff;
  border-width: 0 1.6px 1.6px 0;
  transform: rotate(45deg);
}
.dv-pt.need {
  background: #fff;
  border: 2px dashed var(--eta);
}
.dv-pt.need.late,
.dv-pt.need.missing {
  border-color: var(--late);
}
.dv-pt.need.missing::after {
  content: '?';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 700 8.5px/1 var(--mono);
  color: var(--late);
}
.dv-pt.ghost {
  width: 11px;
  height: 11px;
  background: #fff;
  border: 2px solid var(--drift);
  cursor: pointer;
  z-index: 2;
}
.dv-drift {
  position: absolute;
  top: 28px;
  height: 0;
  border-top: 1.5px dashed var(--drift);
  pointer-events: none;
}
.dv-drift::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -4.5px;
  border: 4px solid transparent;
  border-left: 6px solid var(--drift);
  transform: translateX(4px);
}
.dv-drift.back::after {
  right: auto;
  left: -1px;
  transform: translateX(-10px) rotate(180deg);
}
.dv-tbd {
  position: absolute;
  top: 28px;
  height: 0;
  width: 72px;
  border-top: 1.5px dashed rgba(228, 87, 61, 0.5);
  -webkit-mask: linear-gradient(90deg, #000 30%, transparent);
  mask: linear-gradient(90deg, #000 30%, transparent);
  pointer-events: none;
}
.dv-lbl {
  position: absolute;
  transform: translateX(-50%);
  font: 600 10px/1 var(--mono);
  white-space: nowrap;
  pointer-events: none;
  color: var(--ink);
}
.dv-lbl.up {
  top: 6px;
}
.dv-lbl.down {
  top: 42px;
  color: var(--muted);
  font-weight: 500;
}
.dv-lbl.late {
  color: #b23a22;
}
.dv-lbl.drift {
  color: var(--drift);
}
.dv-lbl small {
  font: 500 9px var(--sans);
  color: var(--muted);
  margin-right: 3px;
}
.dv-hint {
  position: fixed;
  z-index: 200;
  background: var(--ink);
  color: #fff;
  font: 600 11px var(--mono);
  border-radius: 6px;
  padding: 4px 8px;
  pointer-events: none;
  white-space: nowrap;
}
.dv-hint .late {
  color: #ff9c88;
}
.dv-hint .ok {
  color: #8fd6a8;
}
.dv-empty {
  padding: 72px 20px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.9;
}
.dv-empty b {
  color: var(--ink);
}
.dv-empty .ico {
  width: 40px;
  height: 40px;
  margin: 0 auto 12px;
  border-radius: 12px;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}
/* 工具栏：过滤（带计数）+ 图例（DependencyTools.vue） */
.dep-tools .vs-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dep-tools .n {
  font: 600 10px var(--mono);
  color: var(--muted);
  background: var(--bg);
  border-radius: 99px;
  padding: 1px 6px;
}
.dep-tools .vs-btn.active .n {
  background: var(--line2);
}
.dep-tools .n.red {
  background: #fdece8;
  color: #b23a22;
}
.dep-tools .n.amber {
  background: #fbf1e1;
  color: #8a5a12;
}
.dep-legend .g {
  display: inline-block;
  flex: none;
}
.dep-legend .g.eta {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #4a5260;
}
.dep-legend .g.need {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px dashed #4a5260;
}
.dep-legend .g.late {
  width: 18px;
  height: 8px;
  background: rgba(228, 87, 61, 0.1);
  border-top: 2px solid #e4573d;
  border-radius: 2px;
}
.dep-legend .g.span {
  width: 18px;
  height: 5px;
  border-radius: 3px;
  background: repeating-linear-gradient(-45deg, #c9d3dc 0 3px, #e8edf1 3px 6px);
}
@media (max-width: 1100px) {
  .dep-view {
    --dv-left: 260px;
  }
  .dep-legend {
    display: none !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dv-pt,
  .dv-row,
  .dv-acts {
    transition: none !important;
    animation: none !important;
  }
}
</style>
