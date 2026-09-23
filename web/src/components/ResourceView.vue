<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, onUpdated, ref, watch } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import {
  addD,
  colorCls,
  diffD,
  esc,
  fmtISO,
  fmtMD,
  initials,
  parseDate,
  rangesOverlap,
  dateMs,
  today,
  type Timeline,
} from '../composables/useGeometry';
import type { RoadmapItem, RoadmapSub, TeamMember } from '../types';
import { dispName, teamAssigneeMap } from '../composables/useAssigneeMap';
import { tooltipHintLine, epicColor, epicShort, isDoneStatus } from '../composables/useRoadmapContract';
import { planDeferToTarget } from '../composables/useDeferPlan';

const props = defineProps<{ tl: Timeline }>();
const state = useRoadmapState();
const rootEl = ref<HTMLElement | null>(null);
/** Time-band pixel width (root minus the 236px name column) — used to decide
 * whether a bar is wide enough for the Epic-name prefix chip. */
const stripPx = ref(0);
let stripRO: ResizeObserver | null = null;
let wheelTarget: HTMLElement | null = null;
let slidingClearTimer: ReturnType<typeof setTimeout> | null = null;
onMounted(() => {
  const measure = () => {
    stripPx.value = Math.max(0, (rootEl.value?.clientWidth || 0) - 236);
  };
  measure();
  stripRO = new ResizeObserver(measure);
  if (rootEl.value) {
    stripRO.observe(rootEl.value);
  }
});
onUnmounted(() => {
  stripRO?.disconnect();
  wheelTarget?.removeEventListener('wheel', onResWheel);
  wheelTarget = null;
  if (slidingClearTimer) clearTimeout(slidingClearTimer);
});
const assigneeMap = computed(() => teamAssigneeMap(state.snapshot.value));
function showName(name: string | null | undefined) {
  return dispName(assigneeMap.value, name);
}
const addingMember = ref(false);
const newMemberName = ref('');
const renamingId = ref<string | null>(null);
const renameValue = ref('');

const allWin = computed(() => state.resWin.value === 'all');
/** Near-2-weeks window can be panned (see §6): resOffset in days, relative to
 * today. Session-only UI state — not persisted, not synced to teammates. */
const resOffset = ref(0);
const winS = computed(() => (allWin.value ? props.tl.start : addD(today, resOffset.value)));
const winE = computed(() => (allWin.value ? props.tl.end : addD(winS.value, 13)));
const days = computed(() => diffD(winS.value, winE.value) + 1);
/** Pan buffer: one window's worth of days rendered on each side so a drag
 * slides existing bars into view instead of needing a full re-render mid-gesture. */
const BUF = computed(() => (allWin.value ? 0 : days.value));
const rangeS = computed(() => addD(winS.value, -BUF.value));
const rangeE = computed(() => addD(winE.value, BUF.value));
const pxPerDay = computed(() => Math.max(20, stripPx.value / days.value));

type TaskPair = { s: RoadmapSub; it: RoadmapItem };

function tasksOf(name: string | null): TaskPair[] {
  const out: TaskPair[] = [];
  for (const it of state.scheduledItems.value) {
    for (const s of it.subs) {
      if (s.cleared) continue;
      if ((s.owner || null) === name) out.push({ s, it });
    }
  }
  // Greedy lane packing below requires start-ascending input — otherwise it
  // opens lanes it doesn't need to (a later-starting task can land in an
  // earlier lane only if it's seen after that lane's occupant). Same-day
  // starts put the longer task first so short ones have a better chance of
  // slotting into another lane's tail instead of opening a new one.
  return out.sort((a, b) => {
    const byStart = dateMs(a.s.start || '') - dateMs(b.s.start || '');
    if (byStart) return byStart;
    return (b.s.days || 0) - (a.s.days || 0);
  });
}

const orderedEpicKeys = computed(() => state.scheduledItems.value.map((it) => it.key));

/** Simple greedy lane packing so overlapping bars don't stack on one row. */
function placeLanes(tasks: TaskPair[]) {
  const laneEndMs: number[] = [];
  const placed = tasks
    .filter(({ s }) => s.start && s.days)
    .map(({ s, it }) => {
      const end = addD(s.start!, (s.days || 1) - 1);
      const startMs = parseDate(s.start!).getTime();
      const endMs = end.getTime();
      let li = laneEndMs.findIndex((prevEnd) => prevEnd < startMs);
      if (li < 0) {
        li = laneEndMs.length;
        laneEndMs.push(endMs);
      } else {
        laneEndMs[li] = endMs;
      }
      return { s, it, end, li };
    });
  return {
    placed,
    stripH: Math.max(56, laneEndMs.length * 27 + 16),
    laneCount: laneEndMs.length,
  };
}

const rows = computed(() =>
  (state.snapshot.value?.members || []).map((m) => {
    const tasks = tasksOf(m.name);
    return { m, tasks, virtual: false as const, ...placeLanes(tasks) };
  }),
);

const unassigned = computed(() => {
  const tasks = tasksOf(null);
  return { m: null, tasks, virtual: true as const, ...placeLanes(tasks) };
});

/* ---------- 聚焦「正在做」+ 其余延至下周 ----------
   单击任务条标记「正在做」，可继续单击多选；点到另一个成员的任务对那个人重新开始
   多选。顺延对象 = 该成员未选中 && 未清理 && 开始日 < 下周一 && 尚未结束的任务
   （已开始未做完的同样算，已结束的历史记录不算，下周及以后的远任务不算）；开始日
   移到下周一。长度优先保持；不够则按 Jira Original Estimate（空则 3 人天）缩小。
   若下周一到 Epic 结束日仍摆不下最小人天，弹窗询问是否延长 Epic Target End。
   服务端是权威计算（TeamService.defer_subs）；这里的 deferPlan 只用于 UI 预告。 */
const emit = defineEmits<{
  (e: 'defer-committed', payload: { subIds: string[]; itemKeys: string[] }): void;
}>();

const UNASSIGNED_KEY = '__un';
const resSel = ref<{ person: string | null; ids: Set<string> }>({ person: null, ids: new Set() });
let focusHintShown = false;

function clearResSel() {
  if (!resSel.value.person) return;
  resSel.value = { person: null, ids: new Set() };
}

// 换团队 / 换「近 2 周·全部」都回到今天、清空聚焦，不带着旧偏移量或旧选择
watch(
  () => [state.resWin.value, state.snapshot.value?.team.id] as const,
  () => {
    resOffset.value = 0;
    clearResSel();
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') clearResSel();
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));

/** Click on empty space exits focus; clicks on bars/dock/chips handle themselves. */
function onBackgroundClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.closest('.res-bar,.rp-focus,.rp-del,.rp-name,.rp-name-edit,.res-add,.res-chip,.res-today-btn,.modal-back')) return;
  clearResSel();
}

const nextMonday = computed(() => {
  let d = (8 - today.getDay()) % 7;
  if (!d) d = 7;
  return addD(today, d);
});

function isDeferCandidate(s: RoadmapSub): boolean {
  if (isDoneStatus(s)) return false;
  if (!s.start || !s.days) return false;
  const end = addD(s.start, s.days - 1);
  return dateMs(end) >= dateMs(today) && dateMs(s.start) < dateMs(nextMonday.value);
}

/** Plan moving this sub onto next Monday, shrinking to Original Estimate if needed. */
function deferPlan(s: RoadmapSub, it: RoadmapItem) {
  return planDeferToTarget({
    subStart: s.start!,
    subDays: s.days || 1,
    epicStart: it.start!,
    epicDays: it.days || 1,
    targetStart: nextMonday.value,
    originalEstimateDays: s.originalEstimateDays,
  });
}

function personKeyOf(row: { virtual: boolean; m: TeamMember | null }): string {
  return row.virtual ? UNASSIGNED_KEY : row.m!.id;
}

function isFocusing(personKey: string): boolean {
  return resSel.value.person === personKey && resSel.value.ids.size > 0;
}

function moversOf(row: { tasks: TaskPair[] }, personKey: string): TaskPair[] {
  if (!isFocusing(personKey)) return [];
  return row.tasks.filter(({ s }) => !resSel.value.ids.has(s.id) && isDeferCandidate(s));
}

function movableOf(row: { tasks: TaskPair[] }, personKey: string): TaskPair[] {
  return moversOf(row, personKey).filter(({ s, it }) => {
    const fit = deferPlan(s, it).fit;
    return fit === 'fit' || fit === 'shrink';
  });
}

function needingExtendOf(row: { tasks: TaskPair[] }, personKey: string): TaskPair[] {
  return moversOf(row, personKey).filter(({ s, it }) => deferPlan(s, it).fit === 'needs-extend');
}

/**
 * 「其余延至下周」按钮：ready 可直接执行；needs-extend 点开确认框延长 Epic；
 * none 没有候选（都已完成 / 都不在可顺延范围内）。
 */
function goState(row: { tasks: TaskPair[] }, personKey: string): 'ready' | 'needs-extend' | 'none' {
  const movers = moversOf(row, personKey);
  if (!movers.length) return 'none';
  if (needingExtendOf(row, personKey).length) return 'needs-extend';
  return 'ready';
}

function goTip(row: { tasks: TaskPair[] }, personKey: string): string {
  const stateKind = goState(row, personKey);
  if (stateKind === 'ready') {
    return `把 TA 其余开始日在下周一之前、尚未结束的任务，统一延至下周一（${fmtMD(nextMonday.value)}）开始||已开始未做完的同样延后。长度优先保持；空间不够时按 Jira Original Estimate（空则 3 人天）缩小||hover 可预览落点；延完再按一次不会继续往后推`;
  }
  if (stateKind === 'needs-extend') {
    const needing = needingExtendOf(row, personKey);
    const latest = needing.reduce((max, { s, it }) => {
      const end = deferPlan(s, it).neededEpicEnd;
      return !max || end > max ? end : max;
    }, null as Date | null);
    return `这 ${needing.length} 个任务从下周一到当前 Epic 结束日，放不下最小人天（Original Estimate，空则 3 天）||点击后可选择把 Epic 排期结束日延长到 ${latest ? fmtMD(latest) : '所需日期'}，或取消顺延`;
  }
  return '没有需要顺延的任务||其余任务不在可顺延范围内，或已标记完成，不需要处理';
}

function onBarClick(s: RoadmapSub, personKey: string) {
  if (isDoneStatus(s)) return; // 已完成的任务不参与「正在做」多选
  if (resSel.value.person !== personKey) {
    resSel.value = { person: personKey, ids: new Set([s.id]) };
    if (!focusHintShown) {
      focusHintShown = true;
      state.toast('已标记「正在做」，可继续多选；左侧操作点可把 TA 其余任务一键延至下周');
    }
    return;
  }
  const ids = new Set(resSel.value.ids);
  if (ids.has(s.id)) {
    ids.delete(s.id);
    resSel.value = { person: ids.size ? personKey : null, ids };
  } else {
    ids.add(s.id);
    resSel.value = { person: personKey, ids };
  }
}

const previewPerson = ref<string | null>(null);
/** 顺延成功后给移动中的条加上 .slide，让 left 以 0.35s 滑到新位置（对齐 demo）。 */
const slidingIds = ref<Set<string>>(new Set());

/** Fallback hint line for the tooltip (real description still wins via tooltipHintLine). */
function focusTipHint(s: RoadmapSub, it: RoadmapItem, personKey: string): string {
  const base = `主任务：${it.alias || it.title}`;
  if (isDoneStatus(s)) return `${base}||状态：${s.status}（已完成，不参与顺延统计）`;
  if (resSel.value.person !== personKey || !resSel.value.ids.size) {
    return `${base}||单击标记「正在做」，可多选；其余任务可一键延至下周`;
  }
  if (resSel.value.ids.has(s.id)) {
    return `${base}||已标记「正在做」· 再次单击取消`;
  }
  if (!isDeferCandidate(s)) return base;
  const plan = deferPlan(s, it);
  if (plan.fit === 'needs-extend') {
    return `${base}||待延至下周 · 下周一到 Epic 结束日放不下最小人天（${plan.minDays}d），需延长 Epic 到 ${fmtMD(plan.neededEpicEnd)}`;
  }
  if (plan.fit === 'shrink') {
    return `${base}||待延至下周 · 开始日移到下周一 ${fmtMD(nextMonday.value)}，长度从 ${s.days}d 缩到 ${plan.nextDays}d（Original Estimate ${plan.minDays}d）`;
  }
  if (plan.fit === 'fit') {
    return `${base}||待延至下周 · 一键后开始日移到下周一 ${fmtMD(nextMonday.value)}`;
  }
  return base;
}

/** Ghost preview bars for the movable set — shown while hovering "其余延至下周". */
function deferGhosts(row: { placed: ReturnType<typeof placeLanes>['placed'] }, personKey: string) {
  if (previewPerson.value !== personKey) return [];
  const out: Array<{
    id: string;
    cs: Date | string;
    newStart: Date;
    frac: number;
    li: number;
    shrunk: boolean;
  }> = [];
  for (const { s, it, li } of row.placed) {
    if (resSel.value.ids.has(s.id) || !isDeferCandidate(s)) continue;
    const plan = deferPlan(s, it);
    if (!plan.nextStart || !plan.nextDays) continue;
    const ns = plan.nextStart;
    const ne = addD(ns, plan.nextDays - 1);
    if (dateMs(ne) < dateMs(rangeS.value) || dateMs(ns) > dateMs(rangeE.value)) continue;
    const cs = dateMs(ns) < dateMs(rangeS.value) ? rangeS.value : ns;
    const ce = dateMs(ne) > dateMs(rangeE.value) ? rangeE.value : ne;
    out.push({
      id: s.id,
      cs,
      newStart: ns,
      frac: (diffD(cs, ce) + 1) / days.value,
      li,
      shrunk: plan.fit === 'shrink',
    });
  }
  return out;
}

type ExtendPrompt = {
  subIds: string[];
  epics: Array<{ itemKey: string; title: string; end: string }>;
  neededEnd: string;
};

const extendPrompt = ref<ExtendPrompt | null>(null);

function buildExtendPrompt(needing: TaskPair[]): ExtendPrompt {
  const byEpic = new Map<string, { itemKey: string; title: string; end: Date }>();
  for (const { s, it } of needing) {
    const plan = deferPlan(s, it);
    const existing = byEpic.get(it.key);
    if (!existing || plan.neededEpicEnd > existing.end) {
      byEpic.set(it.key, {
        itemKey: it.key,
        title: it.alias || it.title,
        end: plan.neededEpicEnd,
      });
    }
  }
  const epics = [...byEpic.values()].map((e) => ({
    itemKey: e.itemKey,
    title: e.title,
    end: fmtISO(e.end),
  }));
  const neededEnd = epics.reduce((max, e) => (e.end > max ? e.end : max), epics[0]?.end || '');
  return {
    subIds: needing.map(({ s }) => s.id),
    epics,
    neededEnd,
  };
}

async function runDefer(row: { tasks: TaskPair[] }, personKey: string) {
  previewPerson.value = null;
  const movers = moversOf(row, personKey);
  if (!movers.length) {
    state.toast('没有需要顺延的任务');
    return;
  }
  const needing = needingExtendOf(row, personKey);
  const allIds = movers.map(({ s }) => s.id);
  if (needing.length) {
    const prompt = buildExtendPrompt(needing);
    prompt.subIds = allIds;
    extendPrompt.value = prompt;
    return;
  }
  await commitDefer(allIds, []);
}

async function confirmExtendAndDefer() {
  const prompt = extendPrompt.value;
  if (!prompt) return;
  extendPrompt.value = null;
  await commitDefer(
    prompt.subIds,
    prompt.epics.map((e) => ({ itemKey: e.itemKey, end: e.end })),
  );
}

async function commitDefer(
  subIds: string[],
  extendEpics: Array<{ itemKey: string; end: string }>,
) {
  const targetStartIso = fmtISO(nextMonday.value);
  if (slidingClearTimer) clearTimeout(slidingClearTimer);
  slidingIds.value = new Set(subIds);
  await nextTick();
  let summary: {
    moved: string[];
    shrunk: string[];
    stuck: string[];
    extended: string[];
  } | null = null;
  try {
    summary = await state.deferSubsToNextMonday(subIds, targetStartIso, extendEpics);
  } catch {
    slidingIds.value = new Set();
    return;
  }
  if (!summary) {
    slidingIds.value = new Set();
    return;
  }
  slidingClearTimer = setTimeout(() => {
    slidingIds.value = new Set();
    slidingClearTimer = null;
  }, 420);
  const { moved, shrunk, stuck, extended } = summary;
  state.toast(
    `<span class="ok">✓</span> 已将 <b>${moved.length}</b> 个任务延至下周一（${fmtMD(nextMonday.value)}）开始` +
      (shrunk.length ? `，其中 ${shrunk.length} 个按估算缩短了长度` : '') +
      (extended.length
        ? `；已延长 ${extended.length} 个 Epic 结束日到 ${fmtMD(extendEpics[0]?.end || nextMonday.value)}`
        : '') +
      (stuck.length ? `；${stuck.length} 个仍放不下未动` : ''),
  );
  if (moved.length || extended.length) {
    emit('defer-committed', { subIds: moved, itemKeys: extended });
  }
}

function pct(d: Date | string) {
  return (diffD(winS.value, d) / days.value) * 100;
}

/** Clip to the render range (buffer included) — bars poking into the buffer
 * render there and slide into view on pan, instead of being cut at the
 * visible window's edge. */
function barSpan(s: RoadmapSub, end: Date) {
  const cs = dateMs(s.start!) < dateMs(rangeS.value) ? rangeS.value : s.start!;
  const ce = dateMs(end) > dateMs(rangeE.value) ? rangeE.value : end;
  return { cs, ce, frac: (diffD(cs, ce) + 1) / days.value };
}

/** Bar wide enough to fit `[Epic name] label` without crowding the label out. */
function showEpicPrefix(frac: number): boolean {
  return stripPx.value ? frac * stripPx.value > 110 : frac > 0.16;
}

/* ---------- 标题贴边（sticky title）----------
   bar 左侧被裁到可视范围（0%）外、右侧仍有部分可见时（比如已经跑了很久的长任务），
   把「前缀 chip + 标题」这一组整体平移贴到可视范围最左侧，不用平移很久才能看到是
   哪条任务；同时用 max-width 把可用宽度限制为「bar 右边界到可视范围左边界」的剩余
   距离，交给 .rb-label 已有的 overflow:hidden + text-overflow:ellipsis 从后面截断——
   保留标题开头，贴到 bar 末尾位置后面用省略号收住，而不是反直觉地露出标题尾巴。
   （按标题真实宽度反向钳制平移量的写法会导致窄可视段里露出标题尾部而不是开头，
   demo 里踩过这个坑——见 docs/demo/roadmap-demo.html 同名注释——这里直接采用
   「永远贴左 + 限宽交给省略号」的定稿方案。）
   titleGroups 记录每条可见 bar 的 {el, leftPx, rightPx}（在当前 winS/pxPerDay 坐标系
   下，panPx=0 时的边界）；updateStickyLabels(panPx) 用它们换算出该不该贴、贴多少——
   panPx=0 用于渲染后的静止定位，拖动时 applyResPan() 用当前 resPanPx 重算，
   做到「不论左右滚动都固定」。 */
const titleGroups = new Map<string, { el: HTMLElement; leftPx: number; rightPx: number }>();
function setTitleGroupEl(subId: string, el: Element | null, s: RoadmapSub, end: Date) {
  if (!el) {
    titleGroups.delete(subId);
    return;
  }
  const { cs, ce } = barSpan(s, end);
  const leftPx = diffD(winS.value, cs) * pxPerDay.value;
  const rightPx = leftPx + (diffD(cs, ce) + 1) * pxPerDay.value;
  titleGroups.set(subId, { el: el as HTMLElement, leftPx, rightPx });
}
function updateStickyLabels(panPx: number) {
  titleGroups.forEach(({ el, leftPx, rightPx }) => {
    const effLeft = leftPx - panPx;
    const effRight = rightPx - panPx;
    if (effLeft < 0 && effRight > 0) {
      el.style.transform = `translateX(${-effLeft}px)`;
      el.style.maxWidth = `${effRight}px`;
    } else {
      el.style.transform = '';
      el.style.maxWidth = '';
    }
  });
}
onMounted(() => updateStickyLabels(0));
onUpdated(() => updateStickyLabels(0));

/* ---------- 时间窗平移（丝滑版）----------
   渲染时按 3 倍窗宽出内容（BUF，见上）：表头日期格、网格线、任务条都装进平移层
   （每行一个 .res-pan，表头一个 .res-days-pan）。滑动期间只对这些层写 transform
   （1:1 跟手，继承触控板原生惯性），不重建任何 DOM；手势停 140ms 后 commit：
   偏移量落格到整天、重渲染重居中，亚天残差用 settle 弹性动画归零。 */
const headPanEl = ref<HTMLElement | null>(null);
const rowPanEls = new Map<string, HTMLElement>();
function setRowPanEl(key: string, el: Element | null) {
  if (el) rowPanEls.set(key, el as HTMLElement);
  else rowPanEls.delete(key);
}
function panLayers(): HTMLElement[] {
  const els = [...rowPanEls.values()];
  if (headPanEl.value) els.push(headPanEl.value);
  return els;
}

let resPanPx = 0;
let resPanTimer: ReturnType<typeof setTimeout> | null = null;

function applyResPan() {
  panLayers().forEach((el) => {
    el.classList.remove('settle');
    el.style.transform = `translateX(${-resPanPx}px)`;
  });
  updateStickyLabels(resPanPx);
}

function commitResPan() {
  if (resPanTimer) clearTimeout(resPanTimer);
  resPanTimer = null;
  const dd = Math.round(resPanPx / pxPerDay.value);
  const residual = resPanPx - dd * pxPerDay.value;
  resPanPx = 0;
  resOffset.value += dd;
  nextTick(() => {
    if (Math.abs(residual) <= 0.5) return;
    const layers = panLayers();
    layers.forEach((el) => {
      el.classList.remove('settle');
      el.style.transform = `translateX(${-residual}px)`;
    });
    void layers[0]?.offsetWidth; // force reflow so the transition below actually animates
    layers.forEach((el) => {
      el.classList.add('settle');
      el.style.transform = 'translateX(0)';
    });
  });
}

/**双指左右滑动 = 平移时间窗（仅近 2 周模式；纵向滚动仍滚成员列表） */
function onResWheel(e: WheelEvent) {
  if (allWin.value) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  resPanPx += e.deltaX;
  if (Math.abs(resPanPx) >= BUF.value * pxPerDay.value) {
    commitResPan();
    return;
  }
  applyResPan();
  if (resPanTimer) clearTimeout(resPanTimer);
  resPanTimer = setTimeout(commitResPan, 140);
}
onMounted(() => {
  if (!rootEl.value) return;
  wheelTarget = rootEl.value;
  wheelTarget.addEventListener('wheel', onResWheel, { passive: false });
});

/** Animated jump for the overflow chips / "回到今天": slides by transform when
 * it fits inside the render buffer, otherwise just re-renders at the offset. */
function clearPanTransform() {
  panLayers().forEach((el) => {
    el.classList.remove('settle');
    el.style.transform = '';
  });
  updateStickyLabels(0);
}

function panBy(dd: number) {
  if (!dd) return;
  if (Math.abs(dd) > BUF.value) {
    resPanPx = 0;
    resOffset.value += dd;
    nextTick(clearPanTransform);
    return;
  }
  resPanPx = 0;
  const layers = panLayers();
  layers.forEach((el) => {
    el.classList.add('settle');
    el.style.transform = `translateX(${-dd * pxPerDay.value}px)`;
  });
  setTimeout(() => {
    resOffset.value += dd;
    // demo 整树重建会丢掉 transform；Vue 复用节点，必须显式清，否则会叠一次偏移
    nextTick(clearPanTransform);
  }, 190);
}

function overflowCounts(placed: ReturnType<typeof placeLanes>['placed']) {
  let before = 0;
  let after = 0;
  for (const { s, end } of placed) {
    if (dateMs(end) < dateMs(winS.value)) before += 1;
    else if (dateMs(s.start!) > dateMs(winE.value)) after += 1;
  }
  return { before, after };
}

function inWindow(s: RoadmapSub, end: Date | string) {
  return rangesOverlap(s.start!, end, rangeS.value, rangeE.value);
}

async function removeMember(id: string) {
  if (!state.editable.value) return;
  await state.applySnapshotFromIntent({ op: 'remove_member', memberId: id });
  state.toast('成员已移除');
}

async function addMember() {
  if (!newMemberName.value.trim() || !state.editable.value) return;
  await state.applySnapshotFromIntent({
    op: 'add_member',
    name: newMemberName.value.trim(),
  });
  state.toast(`成员「${esc(newMemberName.value.trim())}」已加入团队`);
  addingMember.value = false;
  newMemberName.value = '';
}

function startRename(m: TeamMember) {
  if (!state.editable.value) return;
  renamingId.value = m.id;
  renameValue.value = m.name;
  nextTick(() => {
    const inp = document.querySelector('.rp-name-edit') as HTMLInputElement | null;
    inp?.focus();
    inp?.select();
  });
}

async function commitRename(m: TeamMember) {
  const name = renameValue.value.trim();
  renamingId.value = null;
  if (!name || name === m.name) return;
  try {
    await state.applySnapshotFromIntent({
      op: 'update_member',
      memberId: m.id,
      name,
    });
    state.toast(`成员已改名为「${esc(name)}」`);
  } catch {
    /* toast from apply */
  }
}
</script>

<template>
  <div ref="rootEl" class="res-view" @click="onBackgroundClick">
    <div class="res-head">
      <div class="res-corner">
        成员 / 任务
        <template v-if="allWin">（全部时间轴）</template>
        <template v-else-if="resOffset">
          （{{ fmtMD(winS) }} → {{ fmtMD(winE) }}）
          <button class="res-today-btn" @click="panBy(-resOffset)">回到今天</button>
        </template>
        <template v-else>（今天起 14 天）</template>
        <span
          v-if="!allWin"
          class="res-pan-hint"
          data-tip="时间窗平移||触控板双指左右滑动，或点两端「更早 / 更晚」角标||窗口长度不变（14 天）"
        >⟷</span>
      </div>
      <div class="res-days">
        <template v-if="allWin">
          <div
            v-for="mo in tl.months"
            :key="`${mo.y}-${mo.m}`"
            class="res-day"
            :class="{ today: mo.cur }"
            :style="{ flex: mo.days }"
          >
            <b>{{ mo.y }}-{{ String(mo.m + 1).padStart(2, '0') }}</b>
          </div>
        </template>
        <div v-else ref="headPanEl" class="res-days-pan">
          <div
            v-for="i in days + BUF * 2"
            :key="i"
            class="res-day"
            :style="{ left: `${((i - 1 - BUF) / days) * 100}%`, width: `${100 / days}%` }"
            :class="{
              today: diffD(addD(rangeS, i - 1), today) === 0,
              wkd: addD(rangeS, i - 1).getDay() % 6 === 0,
            }"
          >
            <b>{{ addD(rangeS, i - 1).getDate() }}</b>
            {{ ['日', '一', '二', '三', '四', '五', '六'][addD(rangeS, i - 1).getDay()] }}
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="!rows.length && !unassigned.tasks.length"
      class="res-empty-hint"
    >
      还没有成员数据<br />添加任务时指定 Owner，或在下方<b>添加成员</b>
    </div>

    <div
      v-for="row in [...rows, ...(unassigned.tasks.length ? [unassigned] : [])]"
      :key="personKeyOf(row)"
      class="res-row"
      :class="{ focusing: isFocusing(personKeyOf(row)) }"
    >
      <div class="res-person">
        <span
          class="own-av"
          :style="{ background: row.virtual ? '#C6CDD4' : row.m!.avatarColor }"
        >
          {{ row.virtual ? '?' : initials(row.m!.name) }}
        </span>
        <div class="rp-info">
          <input
            v-if="!row.virtual && renamingId === row.m!.id"
            v-model="renameValue"
            class="rp-name-edit"
            @keydown.enter="commitRename(row.m!)"
            @keydown.esc="renamingId = null"
            @blur="commitRename(row.m!)"
          />
          <div
            v-else
            class="rp-name"
            :data-tip="row.virtual ? undefined : '双击修改名字'"
            @dblclick="!row.virtual && startRename(row.m!)"
          >
            {{ row.virtual ? '未分配' : showName(row.m!.name) }}
          </div>
          <div v-if="row.tasks.length" class="rp-meta">
            {{ row.tasks.length }} 个任务 · 共 {{ row.tasks.reduce((a, t) => a + (t.s.days || 0), 0) }}d
          </div>
          <span v-else class="rp-idle">空闲</span>
          <div v-if="isFocusing(personKeyOf(row))" class="rp-focus">
            <span class="rpf-line">
              ✓ 正在做 {{ resSel.ids.size }} · 待延至下周 {{ moversOf(row, personKeyOf(row)).length }}
            </span>
            <div class="rpf-btns">
              <button
                class="rpf-go"
                :class="{ soft: goState(row, personKeyOf(row)) === 'none' }"
                :data-tip="goTip(row, personKeyOf(row))"
                @mouseenter="previewPerson = personKeyOf(row)"
                @mouseleave="previewPerson = null"
                @click="runDefer(row, personKeyOf(row))"
              >其余延至下周 →</button>
              <button class="rpf-x" data-tip="退出聚焦（Esc / 点空白处）" @click="clearResSel()">✕</button>
            </div>
          </div>
        </div>
        <button
          v-if="!row.virtual && !row.tasks.length && state.editable.value"
          class="rp-del"
          @click="removeMember(row.m!.id)"
        >
          ×
        </button>
      </div>
      <div class="res-strip" :style="{ minHeight: `${row.stripH}px` }">
      <div class="res-pan" :ref="(el) => setRowPanEl(personKeyOf(row), el)">
        <template v-if="!allWin">
          <div
            v-for="i in days + BUF * 2"
            :key="`g-${i}`"
            class="res-gridline"
            :style="{ left: `${((i - 1 - BUF) / days) * 100}%` }"
          />
        </template>
        <div
          v-if="dateMs(today) >= dateMs(rangeS) && dateMs(today) <= dateMs(rangeE)"
          class="res-gridline today"
          :style="{ left: `${((diffD(winS, today) + 0.5) / days) * 100}%` }"
        />
        <template v-for="({ s, it, end, li }) in row.placed" :key="s.id">
          <div
            v-if="inWindow(s, end)"
            class="res-bar"
            :data-sid="s.id"
            :class="[
              isDoneStatus(s) ? 'done' : s.temp ? 'draft' : colorCls(s.start!, s.days!),
              {
                slide: slidingIds.has(s.id),
                'clip-l': dateMs(s.start!) < dateMs(rangeS),
                'clip-r': dateMs(end) > dateMs(rangeE),
                sel: resSel.person === personKeyOf(row) && resSel.ids.has(s.id),
                'will-move':
                  resSel.person === personKeyOf(row) &&
                  resSel.ids.size > 0 &&
                  !resSel.ids.has(s.id) &&
                  isDeferCandidate(s),
                stuck:
                  resSel.person === personKeyOf(row) &&
                  !resSel.ids.has(s.id) &&
                  isDeferCandidate(s) &&
                  deferPlan(s, it).fit === 'needs-extend',
                'at-cap':
                  resSel.person === personKeyOf(row) &&
                  !resSel.ids.has(s.id) &&
                  isDeferCandidate(s) &&
                  deferPlan(s, it).fit === 'shrink',
              },
            ]"
            :style="{
              left: `${pct(barSpan(s, end).cs)}%`,
              width: `${barSpan(s, end).frac * 100}%`,
              top: `${8 + li * 27}px`,
            }"
            :data-tip="`${s.key || '草稿'} · ${it.key} · ${fmtMD(s.start!)} → ${fmtMD(end)} · ${s.days}d||${s.title}||${tooltipHintLine(s.description, focusTipHint(s, it, personKeyOf(row)))}`"
            @click="onBarClick(s, personKeyOf(row))"
          >
            <i class="rb-stripe" :style="{ background: epicColor(orderedEpicKeys, it.key) }" />
            <span
              class="rb-title-group"
              :ref="(el) => setTitleGroupEl(s.id, el, s, end)"
            >
              <span
                v-if="showEpicPrefix(barSpan(s, end).frac)"
                class="rb-parent"
                :style="{ color: epicColor(orderedEpicKeys, it.key) }"
              >{{ epicShort(it) }}</span>
              <span class="rb-label">{{ isDoneStatus(s) ? '✓ ' : '' }}{{ s.alias || s.title }}</span>
            </span>
            <span
              v-if="
                resSel.person === personKeyOf(row) &&
                resSel.ids.size > 0 &&
                !resSel.ids.has(s.id) &&
                isDeferCandidate(s)
              "
              class="rb-shift"
            >{{
              deferPlan(s, it).fit === 'needs-extend'
                ? '✕'
                : deferPlan(s, it).fit === 'shrink'
                  ? '→缩短'
                  : '→下周一'
            }}</span>
          </div>
        </template>
        <div
          v-for="g in deferGhosts(row, personKeyOf(row))"
          :key="`ghost-${g.id}`"
          class="res-bar ghost"
          :class="{ clamped: g.shrunk }"
          :style="{ left: `${pct(g.cs)}%`, width: `${g.frac * 100}%`, top: `${8 + g.li * 27}px` }"
        >
          <span class="rb-label">→ {{ fmtMD(g.newStart) }}{{ g.shrunk ? ' · 缩短' : '' }}</span>
        </div>
      </div>
        <button
          v-if="overflowCounts(row.placed).before"
          class="res-chip"
          :class="{ 'res-chip-btn': !allWin }"
          style="left: 6px"
          :data-tip="allWin ? undefined : '点击向前平移两周（也可双指左右滑动）'"
          @click="!allWin && panBy(-14)"
        >
          ◂ {{ overflowCounts(row.placed).before }} 更早
        </button>
        <button
          v-if="overflowCounts(row.placed).after"
          class="res-chip"
          :class="{ 'res-chip-btn': !allWin }"
          style="right: 6px"
          :data-tip="allWin ? undefined : '点击向后平移两周（也可双指左右滑动）'"
          @click="!allWin && panBy(14)"
        >
          {{ overflowCounts(row.placed).after }} 更晚 ▸
        </button>
      </div>
    </div>

    <div v-if="state.editable.value" class="res-add">
      <button v-if="!addingMember" class="add-ghost" @click="addingMember = true">
        ＋ 添加成员
      </button>
      <input
        v-else
        v-model="newMemberName"
        placeholder="成员姓名，Enter 添加…"
        @keydown.enter="addMember"
        @keydown.esc="addingMember = false"
      />
    </div>
  </div>

  <div
    v-if="extendPrompt"
    class="modal-back show"
    @click.self="extendPrompt = null"
  >
    <div class="modal" style="width: 460px">
      <div class="m-head">
        <div class="m-title">顺延需要延长 Epic</div>
        <div class="m-sub">
          从下周一（{{ fmtMD(nextMonday) }}）到当前 Epic 结束日，放不下这些任务的最小人天（Jira Original Estimate，空则 3 天）。
        </div>
      </div>
      <div class="m-body">
        <p>
          是否把相关 Epic 的排期结束日延长到
          <b>{{ fmtMD(extendPrompt.neededEnd) }}</b>？
        </p>
        <div v-if="extendPrompt.epics.length > 1" class="ai-list">
          <div v-for="e in extendPrompt.epics" :key="e.itemKey" class="ai-row">
            <span class="epic-ref">{{ e.itemKey }}</span>
            <span class="t">{{ e.title }}</span>
            <span class="st">→ {{ fmtMD(e.end) }}</span>
          </div>
        </div>
      </div>
      <div class="m-foot">
        <button class="btn btn-ghost" @click="extendPrompt = null">取消顺延</button>
        <button class="btn btn-primary" @click="confirmExtendAndDefer">延长并顺延</button>
      </div>
    </div>
  </div>
</template>
