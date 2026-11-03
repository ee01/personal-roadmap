import {
  computed,
  inject,
  onMounted,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  watch,
  type InjectionKey,
} from 'vue';
import type {
  ActivityEntry,
  HierarchyMode,
  InitDetail,
  MilestoneFilterMode,
  MilestoneValue,
  ResWindow,
  RoadmapItem,
  RoadmapMarker,
  RoadmapSub,
  RulerMode,
  TeamSnapshot,
  TeamSummary,
  ViewMode,
} from '../types';
import {
  buildStateMessage,
  EMPTY_JQL_HINTS,
  isDraftItem,
} from './useRoadmapContract';
import {
  addD,
  chipList,
  CURQ,
  diffD,
  fmtISO,
  nextQ,
  parseDate,
  prevQ,
  qCmp,
  qEnd,
  today,
} from './useGeometry';
import { useRoadmapApi } from './useRoadmapApi';
import { formatGanttFocus, parseGanttFocus, resolveGanttTarget, type GanttTarget, type GanttLocation } from './ganttLocate';
import { depCommittedText } from './dependency';
import { bridgeFetchCustomLabelValues, bridgeFetchQuarterOptions } from './useExtensionBridge';
import { isDoneStatus, itemDisplayKey } from './useRoadmapContract';

export const ROADMAP_STATE_KEY: InjectionKey<ReturnType<typeof createRoadmapState>> =
  Symbol('roadmap-state');

/** Long enough to swallow a drag's intent + SSE echo, short enough to feel live. */
const STATE_PUSH_DEBOUNCE_MS = 900;

const INTENT_ERROR_TEXT: Record<string, string> = {
  title_required: '请填写标题',
  item_not_found: '条目不存在，可能已被其他人删除',
  item_has_jira: '该条目已在 Jira 中创建，不能从 Roadmap 删除，可退回 Backlog',
  jira_key_required: '缺少 Jira key',
  sub_not_found: '子任务不存在，可能已被其他人删除',
  marker_not_found: '标记不存在，可能已被其他人删除',
  label_required: '请填写名称',
  phase_date_required: '阶段节点必须有日期',
  phase_kind_required: '请选择节点类型',
  invalid_marker_kind: '无效的标记类型',
  merge_names_required: '合并需要选择两个不同的人名',
  merge_same_name: '不能与自身合并',
  merge_target_not_full_name: '合并目标必须是 Firstname Lastname',
  member_name_taken: '该成员名已存在，请用 Assignee 映射的「合并」',
  item_not_draft: '已创建 Jira 的条目不能在 Roadmap 改 description',
  invalid_parent_link: 'Parent Link 需要是 Jira issue key，例如 INIT-123',
  target_start_required: '缺少目标日期',
};

export function intentErrorText(error?: string | null): string {
  const key = String(error || '');
  return INTENT_ERROR_TEXT[key] || `操作失败：${key || 'unknown'}`;
}

export type OptimisticRemoval = {
  id: number;
  kind: 'delete' | 'unschedule';
  itemKey: string;
};

/** 未设置 Target Delivery Quarter 的条目归入的分组值（不是合法 quarter，排序时垫底）。 */
export const QUARTER_NONE = '—';

/**
 * Project in-flight Gantt→Backlog and Backlog deletes onto a server snapshot.
 * Unschedule clears the bar the same way the server does (scheduled off, dates
 * cleared) without mutating the caller's items. Delete drops the row.
 * Already-applied ops are left untouched so a later server snapshot wins.
 */
export function applyOptimisticRemovals(
  snap: TeamSnapshot,
  ops: ReadonlyArray<Pick<OptimisticRemoval, 'kind' | 'itemKey'>>,
): TeamSnapshot {
  if (!ops.length) return snap;
  let items = snap.items;
  for (const op of ops) {
    if (op.kind === 'delete') {
      const next = items.filter((item) => item.key !== op.itemKey);
      if (next.length !== items.length) items = next;
      continue;
    }
    let changed = false;
    const next = items.map((item) => {
      if (item.key !== op.itemKey || !item.scheduled) return item;
      changed = true;
      return {
        ...item,
        scheduled: false,
        start: null,
        days: null,
        expanded: false,
      };
    });
    if (changed) items = next;
  }
  return items === snap.items ? snap : { ...snap, items };
}

/** 未关联 Parent Link 的条目归入的 INIT 分组 Key（不是真实 INIT）。 */
export const INIT_NONE = '__none';

/** 条目所属的 INIT 分组 Key：Parent Link，没有则归入「未关联 INIT」。 */
export function initKeyOf(item: Pick<RoadmapItem, 'parentLink'>): string {
  return item.parentLink || INIT_NONE;
}

export function createRoadmapState() {
  const api = useRoadmapApi();

  const teams = ref<TeamSummary[]>([]);
  const snapshot = shallowRef<TeamSnapshot | null>(null);
  /** Last snapshot received from the server. In-flight removals are projected on top. */
  const baseSnapshot = shallowRef<TeamSnapshot | null>(null);
  const optimisticOps: OptimisticRemoval[] = [];
  let optimisticSeq = 0;
  const loading = ref(true);
  const activity = ref<ActivityEntry[]>([]);
  const activityOpen = ref(false);
  const nameGateOpen = ref(false);
  const popKeys = ref<string[]>([]);
  const enterKey = ref<string | null>(null);
  const newSubId = ref<string | null>(null);
  const toasts = ref<Array<{ id: number; html: string }>>([]);
  let toastSeq = 0;

  const view = ref<ViewMode>('gantt');
  const locate = ref<GanttLocation | null>(null);
  const locateReturn = ref<GanttLocation | null>(null);
  let locateSerial = 0;
  const resourceSelection = ref<{ person: string | null; ids: Set<string> }>({ person: null, ids: new Set() });
  const dependencyFilter = ref<import('./dependency').DependencyFilter>('all');
  const dependencyFocus = ref<string | null>(null);
  const resWin = ref<ResWindow>('2w');
  /** 人员视图「近 2 周」窗口的平移偏移（天，相对今天）。会话级 UI 状态，不持久化；
   *  放在全局 state 是因为复制导出（过滤行）需要与人员视图看到同一个时间窗。 */
  const resOffset = ref(0);
  const focusQuarter = ref(CURQ);
  /** Session-only Sprint↔month toggle; not persisted / not synced. */
  const rulerMode = ref<RulerMode>('release');

  // ---------- Milestone 过滤（Custom Labels） ----------
  // 一个过滤状态（按团队记忆），一个谓词 msMatch，Backlog / 甘特 / 统计共用。
  // 多选之间是 OR（命中任一）；甘特中未匹配的行默认淡化，可切换隐藏。
  const msSel = ref<string[]>([]);
  const msMode = ref<MilestoneFilterMode>(readStoredMsMode());
  const msDictSyncing = ref(false);
  const MS_DICT_TTL_MS = 6 * 60 * 60 * 1000;
  const msSelStorageKey = (teamId: string) =>
    `personalroadmap.msSel.${teamId}`;

  // ---------- Quarter 过滤（Target Delivery Quarter） ----------
  // 与 milestone 过滤同构：一个多选状态（按团队记忆）+ 一个谓词 qMatch，Backlog /
  // 甘特 / 依赖视图 / 复制导出共用（都走 viewMatch）；多选之间 OR，与 milestone /
  // 文本 AND。未设置 Quarter 的条目归入 Q_NONE，可选「未设置」一并过滤。
  const Q_NONE = QUARTER_NONE;
  const Q_OPTS_CACHE_KEY = 'personalroadmap.qOpts';
  const Q_OPTS_TTL_MS = 6 * 60 * 60 * 1000;
  const qSel = ref<string[]>([]);
  /** Jira「Target Delivery Quarter」字段选项；null = 未读到，按回落窗口推算。 */
  const qOptions = ref<string[] | null>(readCachedQuarterOptions());
  const qOptFetchedAt = ref(readCachedQuarterOptionsFetchedAt());
  const qOptSyncing = ref(false);
  const qSelStorageKey = (teamId: string) => `personalroadmap.qSel.${teamId}`;

  function readCachedQuarterOptions(): string[] | null {
    try {
      const parsed = JSON.parse(localStorage.getItem(Q_OPTS_CACHE_KEY) || 'null');
      if (
        parsed &&
        Array.isArray(parsed.values) &&
        Number(parsed.fetchedAt) &&
        Date.now() - parsed.fetchedAt < Q_OPTS_TTL_MS
      ) {
        return parsed.values.map(String).filter(Boolean);
      }
    } catch {
      /* private mode / corrupt cache */
    }
    return null;
  }

  function readCachedQuarterOptionsFetchedAt(): number {
    try {
      const parsed = JSON.parse(localStorage.getItem(Q_OPTS_CACHE_KEY) || 'null');
      return parsed && Number(parsed.fetchedAt) ? Number(parsed.fetchedAt) : 0;
    } catch {
      return 0;
    }
  }

  function readStoredMsMode(): MilestoneFilterMode {
    try {
      return localStorage.getItem('personalroadmap.msMode') === 'hide'
        ? 'hide'
        : 'dim';
    } catch {
      return 'dim';
    }
  }

  const modals = ref({
    team: false,
    jql: false,
    cleanup: false,
    aiCreate: false,
    assigneeMap: false,
  });

  /**
   * Create-Jira run can outlive the modal: user may close the dialog while the
   * extension is still creating / polling. Toolbar button stays busy until this
   * flips back to false; completion always toasts.
   */
  const createJiraRunning = ref(false);
  /** In-flight Agent runs resumed after a tab close / refresh. */
  const resumeBusyTeamIds = ref<string[]>([]);
  const resumeLeft = ref(0);

  // 导入栏勾选的覆盖开关；预览弹窗只读取，不再让用户勾第二遍
  const importOverwrite = ref(false);

  const teamId = computed(() => snapshot.value?.team.id || '');
  const editable = computed(() => Boolean(teamId.value && api.getShareToken(teamId.value)));
  const hasExtension = computed(() => api.hasExtension());
  const visibleActivity = computed(() =>
    activity.value.filter((entry) => !entry.teamId || entry.teamId === teamId.value),
  );

  const scheduledItems = computed(() => {
    if (!snapshot.value) return [] as RoadmapItem[];
    return snapshot.value.items
      .filter((i) => i.scheduled)
      .sort((a, b) => a.lane - b.lane);
  });

  const backlogItems = computed(() => {
    if (!snapshot.value) return [] as RoadmapItem[];
    return snapshot.value.items.filter((i) => !i.scheduled);
  });

  // ---------- Milestone 过滤（Custom Labels） ----------
  const milestones = computed<MilestoneValue[]>(
    () => snapshot.value?.team.customLabels || [],
  );
  const msActive = computed(() => msSel.value.length > 0);
  /** 没有任何 Custom Label 数据时，顶部过滤行整体不显示。 */
  const hasMsData = computed(
    () =>
      milestones.value.length > 0 ||
      Boolean(snapshot.value?.items.some((i) => (i.ms || []).length)),
  );

  function msMatch(item: Pick<RoadmapItem, 'ms'>): boolean {
    if (!msActive.value) return true;
    return (item.ms || []).some((k) => msSel.value.includes(k));
  }

  /**
   * 已排期且未完成的条目：结束日晚于某个选中的 milestone 时，返回差得最远
   * 的那个 {ms, days}（甘特 bar 末端 / Backlog 卡片标红用）。
   */
  function msLateOf(item: RoadmapItem): { ms: MilestoneValue; days: number } | null {
    if (!msActive.value || !item.scheduled || isDoneStatus(item)) return null;
    if (!item.start || !item.days) return null;
    const end = addD(item.start, item.days - 1);
    let worst: { ms: MilestoneValue; days: number } | null = null;
    for (const key of item.ms || []) {
      if (!msSel.value.includes(key)) continue;
      const ms = milestones.value.find((m) => m.key === key);
      if (!ms?.milestoneDate) continue;
      const days = diffD(parseDate(ms.milestoneDate), end);
      if (days > 0 && (!worst || days > worst.days)) worst = { ms, days };
    }
    return worst;
  }

  // ---------- Quarter 过滤（Target Delivery Quarter） ----------
  const qActive = computed(() => qSel.value.length > 0);
  /** 没有任何 Quarter 数据（全部条目未设置且团队无导入记录）时，QUARTER 段不显示。 */
  const hasQData = computed(
    () =>
      (snapshot.value?.items.some((i) => Boolean(i.quarter)) || false) ||
      (snapshot.value?.team.importedQuarters.length || 0) > 0,
  );

  function qMatch(item: Pick<RoadmapItem, 'quarter'>): boolean {
    if (!qActive.value) return true;
    return qSel.value.includes(item.quarter || Q_NONE);
  }

  /** 条目的结束日：已排期 = bar 结束；未排期 = Jira Target End。 */
  function qEndOf(
    item: Pick<RoadmapItem, 'scheduled' | 'start' | 'days' | 'targetEnd'>,
  ): Date | null {
    if (item.scheduled && item.start && item.days) {
      return addD(item.start, item.days - 1);
    }
    return item.targetEnd ? parseDate(item.targetEnd) : null;
  }

  /**
   * 结束日超出其 Target Delivery Quarter 最后一天的天数（Backlog 卡片标红 /
   * 甘特 bar 斜纹用）。默认只看已选中的 Quarter；`force` 供 chip 上的红点在
   * 未开启过滤时也能暴露风险。已完成 / 无日期 / 未设置 Quarter → null。
   */
  function qOverOf(
    item: RoadmapItem,
    force = false,
  ): { q: string; days: number; end: Date; qEnd: Date } | null {
    if (!item.quarter || isDoneStatus(item)) return null;
    if (!force && (!qActive.value || !qSel.value.includes(item.quarter))) {
      return null;
    }
    const end = qEndOf(item);
    if (!end) return null;
    const qe = qEnd(item.quarter);
    const days = diffD(qe, end);
    return days > 0 ? { q: item.quarter, days, end, qEnd: qe } : null;
  }

  /** 候选列表：Jira 字段选项（读不到 → 当前 Quarter 前 2 后 1 回落）+ 条目上出现的新值。 */
  const qCandidates = computed<{
    list: string[];
    extra: string[];
    source: 'jira' | 'fallback';
  }>(() => {
    const items = snapshot.value?.items || [];
    const base = qOptions.value
      ? [...qOptions.value]
      : [prevQ(prevQ(CURQ)), prevQ(CURQ), CURQ, nextQ(CURQ)];
    const extra = [...new Set(items.map((i) => i.quarter).filter(Boolean))]
      .filter((q) => !base.includes(q));
    const list = [...base, ...extra].sort(qCmp);
    if (items.some((i) => !i.quarter)) list.push(Q_NONE);
    return { list, extra, source: qOptions.value ? 'jira' : 'fallback' };
  });

  function qCount(q: string): number {
    const items = snapshot.value?.items || [];
    return items.filter((i) => (i.quarter || Q_NONE) === q).length;
  }

  /** 该 Quarter 下结束日超界的条目数（chip 红点 / 浮层计数；不受过滤开关影响）。 */
  function qOverCount(q: string): number {
    const items = snapshot.value?.items || [];
    if (q === Q_NONE) return 0;
    return items.filter((i) => i.quarter === q && qOverOf(i, true)).length;
  }

  /** 快速平铺的 Quarter：当前 + 下一个，外加已选中的其他 Quarter（便于一键取消）。 */
  const quickQuarters = computed(() =>
    [...new Set([CURQ, nextQ(CURQ), ...qSel.value])].sort((a, b) =>
      a === Q_NONE ? 1 : b === Q_NONE ? -1 : qCmp(a, b),
    ),
  );

  function setQSel(keys: string[]) {
    const next = [...new Set(keys)];
    if (
      JSON.stringify([...next].sort()) !== JSON.stringify([...qSel.value].sort())
    )
      cancelLocate();
    qSel.value = next;
    const id = teamId.value;
    if (id) {
      try {
        localStorage.setItem(qSelStorageKey(id), JSON.stringify(qSel.value));
      } catch {
        /* private mode */
      }
    }
  }

  function loadQSel(teamId: string): string[] {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(qSelStorageKey(teamId)) || '[]',
      );
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  /**
   * 经扩展读 Jira「Target Delivery Quarter」字段选项并缓存（6 小时 TTL，
   * localStorage 兜底）；读不到（无扩展 / 未实现 / 失败）时保持回落窗口。
   */
  async function syncQuarterOptions(opts: { force?: boolean } = {}): Promise<void> {
    if (qOptSyncing.value) return;
    if (
      !opts.force &&
      qOptFetchedAt.value > 0 &&
      Date.now() - qOptFetchedAt.value < Q_OPTS_TTL_MS
    ) {
      return;
    }
    if (!api.hasExtension()) return;
    qOptSyncing.value = true;
    try {
      const values = await bridgeFetchQuarterOptions();
      if (!values.length) return;
      qOptions.value = values;
      qOptFetchedAt.value = Date.now();
      try {
        localStorage.setItem(
          Q_OPTS_CACHE_KEY,
          JSON.stringify({ values, fetchedAt: qOptFetchedAt.value }),
        );
      } catch {
        /* private mode */
      }
    } catch {
      /* 扩展未实现 / 未登录：保持回落窗口，浮层里说明来源 */
    } finally {
      qOptSyncing.value = false;
    }
  }

  // ---------- 层级（Epic / INIT）· E-171 ----------
  // 「层级」与「任务 / 人员 / 依赖视图」正交：INIT 是「汇总与上下文」，不是新的
  // 排期对象；组头只读、只汇总，排期 / 依赖 / 批量操作仍落在 Epic / 子任务上。
  // 切换只是本人的查看偏好（localStorage），不改共享排期 / Parent Link / Jira。
  const HIERARCHY_KEY = 'personalroadmap.tier';
  const INIT_MODE_KEY = 'personalroadmap.initMode';
  const INIT_FOLD_KEY = 'personalroadmap.initFold';
  const hierarchy = ref<HierarchyMode>(readStoredHierarchy());
  const isInit = computed(() => hierarchy.value === 'init');
  // INIT 层级下非命中的兄弟 Epic 默认「隐藏」（避免把其他季度误读成范围内）；
  // Epic 层级沿用原有默认「淡化」。
  const initMode = ref<MilestoneFilterMode>(readStoredInitMode());
  /** 甘特中未匹配行的处理方式：按层级分开记忆（INIT 默认 hide，Epic 默认 dim）。 */
  const dimMode = computed<MilestoneFilterMode>(() =>
    isInit.value ? initMode.value : msMode.value,
  );
  // INIT 分组的折叠状态：Backlog / 甘特分别记忆。
  const initFold = ref<{ bl: Set<string>; g: Set<string> }>(loadInitFold());

  function readStoredHierarchy(): HierarchyMode {
    try {
      return localStorage.getItem(HIERARCHY_KEY) === 'init' ? 'init' : 'epic';
    } catch {
      return 'epic';
    }
  }

  function readStoredInitMode(): MilestoneFilterMode {
    try {
      return localStorage.getItem(INIT_MODE_KEY) === 'dim' ? 'dim' : 'hide';
    } catch {
      return 'hide';
    }
  }

  function loadInitFold(): { bl: Set<string>; g: Set<string> } {
    try {
      const o = JSON.parse(localStorage.getItem(INIT_FOLD_KEY) || '{}');
      return { bl: new Set(o.bl || []), g: new Set(o.g || []) };
    } catch {
      return { bl: new Set(), g: new Set() };
    }
  }

  function saveInitFold() {
    try {
      localStorage.setItem(
        INIT_FOLD_KEY,
        JSON.stringify({ bl: [...initFold.value.bl], g: [...initFold.value.g] }),
      );
    } catch {
      /* private mode */
    }
  }

  function setHierarchy(v: HierarchyMode) {
    if (hierarchy.value === v) return;
    hierarchy.value = v;
    try {
      localStorage.setItem(HIERARCHY_KEY, v);
    } catch {
      /* private mode */
    }
    cancelLocate();
  }

  function setInitMode(mode: MilestoneFilterMode) {
    if (mode !== initMode.value) cancelLocate();
    initMode.value = mode;
    try {
      localStorage.setItem(INIT_MODE_KEY, mode);
    } catch {
      /* private mode */
    }
  }

  /** 展开 / 折叠某个 INIT 分组；`which` = 'bl'（Backlog）| 'g'（甘特）。 */
  function toggleInitFold(which: 'bl' | 'g', key: string, force?: boolean) {
    const next = { bl: new Set(initFold.value.bl), g: new Set(initFold.value.g) };
    const set = next[which];
    const collapsed = set.has(key);
    if (force === true ? collapsed : !collapsed) set.delete(key);
    else set.add(key);
    initFold.value = next;
    saveInitFold();
  }

  /** 已加载的 INIT 详情（Key → 标题 / 自身 Quarter / 自身 Committed）。 */
  const inits = computed<Map<string, InitDetail>>(() => {
    const map = new Map<string, InitDetail>();
    for (const detail of snapshot.value?.inits || []) map.set(detail.key, detail);
    return map;
  });

  /** INIT 分组的信息：详情未加载时只知 Key，不伪造标题。 */
  function initInfo(key: string): {
    key: string;
    none: boolean;
    loaded: boolean;
    title: string | null;
    quarter: string | null;
    committed: string | null;
  } {
    if (key === INIT_NONE)
      return { key, none: true, loaded: false, title: null, quarter: null, committed: null };
    const detail = inits.value.get(key);
    return detail
      ? { key, none: false, loaded: true, title: detail.title, quarter: detail.quarter, committed: detail.committed }
      : { key, none: false, loaded: false, title: null, quarter: null, committed: null };
  }

  function initName(key: string): string {
    const info = initInfo(key);
    if (info.none) return '未关联 INIT';
    return info.loaded && info.title ? `${key} ${info.title}` : `${key}（详情未加载）`;
  }

  function initShortName(key: string): string {
    return key === INIT_NONE ? '未关联' : key;
  }

  /** 排序：已加载详情的在前，未加载的其次，「未关联」垫底；再按 Key。 */
  function initKeyCmp(a: string, b: string): number {
    const rank = (k: string) => (k === INIT_NONE ? 2 : inits.value.has(k) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  }

  /** 按 INIT 分组（保持传入顺序，分组 Key 需排序时用 initKeyCmp）。 */
  function initGroups(items: RoadmapItem[]): Map<string, RoadmapItem[]> {
    const map = new Map<string, RoadmapItem[]>();
    for (const item of items) {
      const key = initKeyOf(item);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return map;
  }

  /** 某个 INIT 下已加载的全部 Epic、命中集合及其排期 / 待排期拆分。 */
  function initStats(key: string): {
    all: RoadmapItem[];
    hit: RoadmapItem[];
    sched: RoadmapItem[];
    back: RoadmapItem[];
  } {
    const all = (snapshot.value?.items || []).filter((i) => initKeyOf(i) === key);
    const hit = all.filter((i) => viewMatch(i));
    return {
      all,
      hit,
      sched: hit.filter((i) => i.scheduled),
      back: hit.filter((i) => !i.scheduled),
    };
  }

  /** 筛选生效时 0 命中的 INIT：不显示，但要在底部说明一句。 */
  function zeroHitInits(): string[] {
    if (!filterActive.value) return [];
    const keys = [...new Set((snapshot.value?.items || []).map(initKeyOf))];
    return keys.filter((k) => initStats(k).hit.length === 0).sort(initKeyCmp);
  }

  /** 所选 Quarter 里一个条目都没有、也没拉取过的 → 「尚未拉取」而非「无匹配」。 */
  function unpulledSelectedQuarters(): string[] {
    const imported = snapshot.value?.team.importedQuarters || [];
    const items = snapshot.value?.items || [];
    return qSel.value.filter(
      (q) => q !== QUARTER_NONE && !imported.includes(q) && !items.some((i) => i.quarter === q),
    );
  }

  // ---------- 全局文本过滤 ----------
  // 与 milestone / quarter 过滤 AND，同时作用于 Backlog 与甘特；仅本次会话，切换团队清空。
  const searchQuery = ref('');
  const searchActive = computed(() => searchQuery.value.trim().length > 0);
  /** 任一视图过滤生效（milestone / quarter / 文本）；甘特据此决定是否淡化 / 隐藏未匹配行。 */
  const filterActive = computed(
    () => msActive.value || qActive.value || searchActive.value,
  );

  function textMatch(item: RoadmapItem): boolean {
    const tokens = searchQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const initTitle = item.parentLink ? inits.value.get(item.parentLink)?.title || '' : '';
    const haystack = [
      item.title,
      item.key,
      item.jiraKey || '',
      item.alias || '',
      item.type || '',
      item.quarter || '',
      item.parentLink || '',
      item.owner || '',
      itemDisplayKey(item),
      // E-171：搜 INIT Key / 已加载标题也能命中其子 Epic
      initTitle,
      ...(item.markers || []).filter(m => m.kind === 'dep').flatMap(m => [m.label, m.jiraKey || '', m.jiraStatus || '']),
      // 甘特上展开的子任务也能被搜到（命中子任务即保留其父条目）
      ...(item.subs || []).flatMap((sub) => [sub.title, sub.key || '', sub.alias || '', sub.owner || '']),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  /** Backlog / 甘特共用的最终谓词：milestone（OR）AND quarter（OR）AND 文本。 */
  function viewMatch(item: RoadmapItem): boolean {
    return msMatch(item) && qMatch(item) && textMatch(item);
  }

  function setSearchQuery(q: string) {
    if (q !== searchQuery.value) cancelLocate();
    searchQuery.value = q;
  }

  const msStats = computed(() => {
    const items = snapshot.value?.items || [];
    const hits = items.filter((i) => viewMatch(i));
    const late = hits.filter((i) => msLateOf(i) !== null).length;
    const qOver = hits.filter((i) => qOverOf(i) !== null).length;
    const scheduled = hits.filter((i) => i.scheduled).length;
    // E-171：过滤行只统计「Epic 自身 Committed = No」，不从依赖 / 子项推导。
    const uc = ucOn.value
      ? hits.filter((i) => i.committed === 'No' && !isDoneStatus(i)).length
      : 0;
    return { hits: hits.length, scheduled, late, qOver, uc };
  });

  // ---------- Committed = No（E-171）----------
  // 黄色标签只表达「当前这一行对象自身」的 Jira Committed 字段：Epic 行读 Epic
  // 自身；INIT 行读 INIT 自身（不从子 Epic / 依赖推导；详情未加载 = 未知，不
  // 当作 No）。只在 Quarter / Milestone 过滤生效时出现；依赖目标的 Committed
  // 不做常驻标签，只在 hover / 键盘聚焦时在浮层里带 Ticket Key 说明。
  const ucOn = computed(() => qActive.value || msActive.value);

  function ucScopeText(): string {
    return [
      qActive.value && `Quarter「${qSel.value.join('/')}」`,
      msActive.value && `Milestone「${msSel.value.map((k) => milestones.value.find((m) => m.key === k)?.name || k).join('/')}」`,
    ]
      .filter(Boolean)
      .join(' + ');
  }

  /** Epic 自身是否应标「Committed: No」（在范围内、未完成、且过滤生效）。 */
  function itemUc(item: RoadmapItem): boolean {
    return ucOn.value && item.committed === 'No' && !isDoneStatus(item) && viewMatch(item);
  }

  /** INIT 自身是否应标「Committed: No」；详情未加载不会是 No。 */
  function initUc(key: string): boolean {
    return ucOn.value && key !== INIT_NONE && inits.value.get(key)?.committed === 'No';
  }


  function setMsSel(keys: string[]) {
    const next = [...new Set(keys)];
    if (JSON.stringify([...next].sort()) !== JSON.stringify([...msSel.value].sort())) cancelLocate();
    msSel.value = next;
    const id = teamId.value;
    if (id) {
      try {
        localStorage.setItem(
          msSelStorageKey(id),
          JSON.stringify(msSel.value),
        );
      } catch {
        /* private mode */
      }
    }
  }

  function setMsMode(mode: MilestoneFilterMode) {
    if (mode !== msMode.value) cancelLocate();
    msMode.value = mode;
    try {
      localStorage.setItem('personalroadmap.msMode', mode);
    } catch {
      /* private mode */
    }
  }

  function loadMsSel(teamId: string): string[] {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(msSelStorageKey(teamId)) || '[]',
      );
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  const msDictUpdatedAt = computed(() =>
    milestones.value.reduce((max, v) => Math.max(max, v.fetchedAt), 0),
  );
  /** 超过 6 小时的字典在打开浮层时后台刷新一次（stale-while-revalidate 兜底）。 */
  const msDictStale = computed(
    () =>
      msDictUpdatedAt.value > 0 &&
      Date.now() - msDictUpdatedAt.value > MS_DICT_TTL_MS,
  );

  /**
   * Milestone 字典同步：扩展用用户自己的 Jira 登录态拉取 value 详情，服务端解析
   * 日期并缓存（团队维度），没装扩展的人直接读缓存。
   * - `force`（点「拉取」时）：强制刷新全部已知 key 的日期与描述
   * - 默认（静默刷新后 / 打开浮层时）：只补拉字典里还没有的新 key；
   *   超过 6 小时的条目也一并刷新
   */
  async function syncMilestoneDictionary(
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (!teamId.value || !editable.value || !api.hasExtension()) return;
    if (msDictSyncing.value) return;
    const snap = snapshot.value;
    if (!snap) return;
    const dict = new Map(
      (snap.team.customLabels || []).map((v) => [v.key, v]),
    );
    const keys = new Set<string>();
    for (const item of snap.items) {
      for (const key of item.ms || []) keys.add(key);
    }
    if (!keys.size) return;
    const unknown = [...keys].filter((k) => !dict.has(k));
    // 默认只拉新 key；只有明确 force（拉取按钮 / 浮层手动刷新）才重刷全部
    const toFetch = opts.force ? [...keys] : unknown;
    if (!toFetch.length) return;
    msDictSyncing.value = true;
    try {
      const values = await bridgeFetchCustomLabelValues(toFetch);
      if (!values.length) return;
      await api.upsertCustomLabelValues(teamId.value, values);
      commitSnapshot(await api.fetchTeam(teamId.value));
    } catch (err) {
      console.debug('[roadmap] milestone dictionary sync skipped', err);
    } finally {
      msDictSyncing.value = false;
    }
  }

  const jqlHints = computed(() => snapshot.value?.team.jqlHints || EMPTY_JQL_HINTS);

  /**
   * `confident` only covers the issue type, so the project key has to be
   * checked separately. When either is missing the create modal asks the user
   * to fill it in rather than refusing outright.
   */
  const hintsComplete = computed(
    () => jqlHints.value.confident && Boolean(jqlHints.value.projectKey),
  );

  function toast(html: string, durationMs = 2900) {
    const id = ++toastSeq;
    toasts.value.push({ id, html });
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, durationMs);
  }

  function readUrlParams() {
    const p = new URLSearchParams(location.search);
    return {
      team: p.get('team') || '',
      token: p.get('token') || '',
      q: p.get('q') || '',
      view: (p.get('view') as ViewMode) || 'gantt',
      expand: p.get('expand') || '',
      w: (p.get('w') as ResWindow) || '2w',
      focus: p.get('focus'),
    };
  }

  /**
   * Expand/collapse is per-viewer UI state (URL `expand=` + local Set).
   * Never read/write `item.expanded` from the shared snapshot for display —
   * that field is legacy and must not affect other collaborators.
   */
  const expandedKeys = ref<Set<string>>(new Set());

  function overlayExpand(snap: TeamSnapshot): TeamSnapshot {
    return {
      ...snap,
      items: snap.items.map((item) => ({
        ...item,
        expanded: expandedKeys.value.has(item.key),
      })),
    };
  }

  function publishSnapshot() {
    const base = baseSnapshot.value;
    snapshot.value = base
      ? overlayExpand(applyOptimisticRemovals(base, optimisticOps))
      : null;
  }

  function commitSnapshot(snap: TeamSnapshot) {
    baseSnapshot.value = snap;
    publishSnapshot();
  }

  function dropOptimistic(id: number) {
    const index = optimisticOps.findIndex((op) => op.id === id);
    if (index >= 0) optimisticOps.splice(index, 1);
  }

  function setItemExpanded(key: string, open: boolean) {
    const next = new Set(expandedKeys.value);
    if (open) next.add(key);
    else next.delete(key);
    expandedKeys.value = next;
    publishSnapshot();
    syncUrl();
  }

  function syncUrl() {
    if (!teamId.value) return;
    const p = new URLSearchParams();
    p.set('team', teamId.value);
    if (focusQuarter.value) p.set('q', focusQuarter.value);
    if (view.value !== 'gantt') p.set('view', view.value);
    if (locate.value) p.set('focus', formatGanttFocus(locate.value.target));
    const scheduledKeys = new Set(scheduledItems.value.map((i) => i.key));
    const expanded = [...expandedKeys.value].filter((k) => scheduledKeys.has(k));
    if (expanded.length) p.set('expand', expanded.join(','));
    if (view.value === 'resource' && resWin.value !== '2w') p.set('w', resWin.value);
    const url = `${location.pathname}?${p.toString()}`;
    history.replaceState(null, '', url);
  }

  function cancelLocate() { locate.value = null; syncUrl(); }

  function locateInGantt(target: GanttTarget, fromUrl = false) {
    const resolved = resolveGanttTarget(scheduledItems.value, target);
    if (!resolved) { toast('目标已不在甘特上，可能已退回 Backlog 或被移除'); return false; }
    const from = !fromUrl && (view.value === 'dependency' || view.value === 'resource') ? view.value : null;
    const host = from ? document.querySelector<HTMLElement>(from === 'dependency' ? '.dep-view' : '.res-view') : null;
    locate.value = { target, from, scrollTop: host?.scrollTop || 0, scrollLeft: host?.scrollLeft || 0, label: resolved.label, serial: ++locateSerial };
    locateReturn.value = null;
    if (target.subId) setItemExpanded(target.itemKey, true);
    view.value = 'gantt';
    syncUrl();
    return true;
  }

  function returnFromLocate() {
    const origin = locate.value;
    cancelLocate();
    if (!origin?.from) return;
    locateReturn.value = origin;
    view.value = origin.from;
  }

  watch(view, value => { if (value !== 'gantt' && locate.value) cancelLocate(); }, { flush: 'sync' });
  watch(scheduledItems, items => {
    if (locate.value && !resolveGanttTarget(items, locate.value.target)) {
      cancelLocate(); toast('定位目标已被移除，已结束定位');
    }
  });

  async function loadTeams(preferredTeamId?: string) {
    const url = readUrlParams();
    if (url.token && (url.team || preferredTeamId)) {
      api.setShareToken(url.team || preferredTeamId!, url.token);
    }
    const hint = preferredTeamId || url.team || '';
    if (hint) api.rememberKnownTeam(hint);
    teams.value = await api.listTeams();
    if (hint && !teams.value.some((t) => t.id === hint)) {
      try {
        const snap = await api.fetchTeam(hint);
        api.rememberKnownTeam(hint);
        teams.value = [
          ...teams.value,
          {
            id: snap.team.id,
            name: snap.team.name,
            jql: snap.team.jql,
            checkedQuarters: snap.team.checkedQuarters,
            importedQuarters: snap.team.importedQuarters,
            version: snap.team.version,
          },
        ];
      } catch {
        /* unknown or deleted team */
      }
    }
    const target =
      (hint && teams.value.some((t) => t.id === hint) ? hint : '') ||
      teams.value[0]?.id ||
      '';
    if (target) await selectTeam(target, { fromUrl: Boolean(url.team), expand: url.expand });
    else loading.value = false;
  }

  async function selectTeam(
    id: string,
    opts: { fromUrl?: boolean; expand?: string } = {},
  ) {
    const url = readUrlParams();
    locate.value = null;
    locateReturn.value = null;
    resourceSelection.value = { person: null, ids: new Set() };
    loading.value = true;
    activity.value = [];
    api.unsubscribeEvents();
    try {
      const snap = await api.fetchTeam(id);
      // Restore expand from URL when landing via link; clear when switching teams.
      if (opts.fromUrl || opts.expand !== undefined) {
        expandedKeys.value = new Set(
          String(opts.expand || '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
        );
      } else {
        expandedKeys.value = new Set();
      }
      commitSnapshot(snap);
      focusQuarter.value = url.q || CURQ;
      view.value = url.view || 'gantt';
      resWin.value = url.w || '2w';
      if (opts.fromUrl && url.focus) {
        const target = parseGanttFocus(url.focus);
        if (target) locateInGantt(target, true);
        else toast('定位链接无效，已显示当前甘特');
      }
      msSel.value = loadMsSel(id);
      qSel.value = loadQSel(id);
      searchQuery.value = '';
      activity.value = (await api.fetchActivity(id)).filter(
        (entry) => !entry.teamId || entry.teamId === id,
      );
      api.subscribeEvents(id, {
        onSnapshot: (s) => {
          commitSnapshot(s);
        },
        onActivity: (entry) => {
          if (entry.teamId && entry.teamId !== id) return;
          activity.value = [entry, ...activity.value].slice(0, 100);
        },
      });
      syncUrl();
    } finally {
      loading.value = false;
    }
  }

  function applyPlanningReceipt(receipt: {
    createdParents?: string[];
    attachedParents?: string[];
  }) {
    const keys = [
      ...new Set([
        ...(receipt.createdParents || []),
        ...(receipt.attachedParents || []),
      ]),
    ].filter(Boolean);
    popKeys.value = keys;
    if (keys[0]) enterKey.value = keys[0];
    const next = new Set(expandedKeys.value);
    for (const key of keys) next.add(key);
    expandedKeys.value = next;
    publishSnapshot();
    view.value = 'gantt';
    const first = snapshot.value?.items.find((item) => keys.includes(item.key));
    if (first?.quarter) focusQuarter.value = first.quarter;
    syncUrl();
    requestAnimationFrame(() => {
      const target = keys[0]
        ? document.querySelector(`.g-row[data-key="${CSS.escape(keys[0])}"]`)
        : null;
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    window.dispatchEvent(
      new CustomEvent('roadmap-planning-committed', { detail: { keys } }),
    );
  }

  async function applySnapshotFromIntent(
    intent: Record<string, unknown>,
  ) {
    if (!teamId.value || !editable.value) return;
    try {
      commitSnapshot(await api.sendIntent(teamId.value, intent));
    } catch (err: unknown) {
      const e = err as { status?: number; body?: { error?: string } };
      if (e.status === 409) {
        toast('版本冲突，正在刷新…');
        commitSnapshot(await api.fetchTeam(teamId.value));
      } else {
        toast(intentErrorText(e.body?.error));
      }
      throw err;
    }
  }

  /**
   * Remove a Gantt bar (back to Backlog) or a Backlog row as soon as the user
   * clicks. The projection stays on top of any snapshot that arrives while the
   * intent is in flight, so a slower response or SSE echo cannot paint the row
   * back. On failure the projection is dropped and the latest server snapshot
   * — including the 409 refresh inside applySnapshotFromIntent — puts the item
   * back; that path also toasts the error.
   */
  async function applyOptimisticRemoval(
    removal: Pick<OptimisticRemoval, 'kind' | 'itemKey'>,
    intent: Record<string, unknown>,
  ) {
    if (!teamId.value || !editable.value || !baseSnapshot.value) return;
    const id = ++optimisticSeq;
    optimisticOps.push({ id, ...removal });
    publishSnapshot();
    try {
      await applySnapshotFromIntent(intent);
      dropOptimistic(id);
      publishSnapshot();
    } catch (err) {
      dropOptimistic(id);
      publishSnapshot();
      throw err;
    }
  }

  /** "其余延至下周": batch-moves subs and reports which ones actually moved so
   * the caller can toast a summary and Jira-sync the moved ones. Null subIds
   * (already resolved, editable off, etc.) return null — nothing to report. */
  async function deferSubsToNextMonday(
    subIds: string[],
    targetStart: string,
    extendEpics: Array<{ itemKey: string; end: string }> = [],
  ) {
    if (!teamId.value || !editable.value || !subIds.length) return null;
    try {
      const data = await api.deferSubs(teamId.value, subIds, targetStart, extendEpics);
      commitSnapshot(data.snapshot);
      return data.deferSummary || null;
    } catch (err: unknown) {
      const e = err as { status?: number; body?: { error?: string } };
      if (e.status === 409) {
        toast('版本冲突，正在刷新…');
        commitSnapshot(await api.fetchTeam(teamId.value));
      } else {
        toast(intentErrorText(e.body?.error));
      }
      throw err;
    }
  }

  function ensureActorName(): boolean {
    if (!api.actorName.value.trim()) {
      nameGateOpen.value = true;
      return false;
    }
    return true;
  }

  function expiredStats() {
    const epics: RoadmapItem[] = [];
    const subs: Array<{ subId: string; item: RoadmapItem }> = [];
    for (const it of scheduledItems.value) {
      if (!it.start || !it.days) continue;
      if (addD(it.start, it.days - 1) < today) epics.push(it);
      else {
        for (const s of it.subs) {
          if (s.cleared || !s.start || !s.days) continue;
          if (addD(s.start, s.days - 1) < today) {
            subs.push({ subId: s.id, item: it });
          }
        }
      }
    }
    return { epics, subs };
  }

  /** Scheduled main items that still have no Jira issue. */
  function draftItems(): RoadmapItem[] {
    return scheduledItems.value.filter(isDraftItem);
  }

  /** Draft sub-tasks, paired with the main item they hang off. */
  function draftSubs(): Array<{ item: RoadmapItem; sub: RoadmapSub }> {
    const out: Array<{ item: RoadmapItem; sub: RoadmapSub }> = [];
    for (const it of scheduledItems.value) {
      for (const s of it.subs) {
        if (s.temp && !s.cleared) out.push({ item: it, sub: s });
      }
    }
    return out;
  }

  function pendingImportQuarters(checked: string[], imported: string[]) {
    return checked.filter((q) => !imported.includes(q));
  }

  function postMessageState() {
    return buildStateMessage({
      teamId: snapshot.value?.team.id || null,
      teamName: snapshot.value?.team.name || null,
      quarter: focusQuarter.value,
      editable: editable.value,
      items: scheduledItems.value,
    });
  }

  /**
   * Push the state to the extension so memory picks up drags, new manual items
   * and drafts that just got a Jira key. Debounced because a drag commits one
   * intent per pointer-up and the snapshot also arrives over SSE.
   */
  function pushStateToExtension() {
    if (!editable.value || !snapshot.value) return;
    window.postMessage(postMessageState(), '*');
  }

  let statePushTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePushState() {
    if (statePushTimer) clearTimeout(statePushTimer);
    statePushTimer = setTimeout(() => {
      statePushTimer = null;
      pushStateToExtension();
    }, STATE_PUSH_DEBOUNCE_MS);
  }

  function onWindowMessage(ev: MessageEvent) {
    const data = ev.data || {};
    if (data.type === 'pai-roadmap-hello') {
      api.markExtensionConnected();
      // Ask extension for Glip identity so we can skip the name gate.
      window.postMessage(
        { type: 'pai-roadmap-request-identity', source: 'page' },
        '*',
      );
      const payload = postMessageState();
      ev.source?.postMessage(payload, { targetOrigin: '*' });
      return;
    }
    if (data.type === 'pai-roadmap-identity') {
      const name = String(data.name || '').trim();
      if (!name) return;
      api.setActorName(name);
      api.markExtensionConnected();
      nameGateOpen.value = false;
      return;
    }
    if (data.type === 'pai-roadmap-agent-resume') {
      const teamIds = Array.isArray(data.teamIds)
        ? data.teamIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
        : [];
      const count = Math.max(0, Number(data.runningCount) || 0);
      resumeBusyTeamIds.value = teamIds;
      resumeLeft.value = count;
      if (count > 0 && teamIds.includes(teamId.value)) {
        createJiraRunning.value = true;
        toast('检测到未完成的 Agent 创建，正在同步 Jira 回写…', 3600);
      }
      return;
    }
    if (data.type === 'pai-roadmap-agent-reconciled') {
      const reconciledTeam = String(data.teamId || '').trim();
      resumeLeft.value = Math.max(0, resumeLeft.value - 1);
      const forThisTeam = reconciledTeam === teamId.value;
      if (forThisTeam) {
        const created = Number(data.created) || 0;
        const failed = Number(data.failed) || 0;
        const stillRunning = Boolean(data.stillRunning);
        if (created) {
          toast(
            `<span class="ok">✓</span> 已补回写 <b>${created}</b> 个 Jira issue`,
            4200,
          );
        } else if (stillRunning) {
          toast(
            'Agent 仍在后台执行。可先离开本页，下次打开 Roadmap 会再同步。',
            5200,
          );
        } else if (data.error && !stillRunning) {
          toast(String(data.error), 5200);
        } else if (failed && !stillRunning && !created) {
          toast('上次 Agent 创建未返回可回写的 Jira key', 4200);
        }
        if (teamId.value) {
          api.fetchTeam(teamId.value).then((snap) => {
            commitSnapshot(snap);
          }).catch(() => undefined);
        }
      }
      if (
        resumeLeft.value === 0 &&
        resumeBusyTeamIds.value.includes(teamId.value)
      ) {
        createJiraRunning.value = false;
        resumeBusyTeamIds.value = [];
      }
    }
  }

  onMounted(() => {
    window.addEventListener('message', onWindowMessage);
    // Prefer extension identity; only fall back to manual name gate after a short wait.
    if (!api.actorName.value.trim()) {
      if (api.hasExtension()) {
        window.postMessage(
          { type: 'pai-roadmap-request-identity', source: 'page' },
          '*',
        );
      }
      window.setTimeout(() => {
        if (!api.actorName.value.trim()) nameGateOpen.value = true;
      }, 1200);
    }
    loadTeams().catch((e) => {
      console.error(e);
      loading.value = false;
    });
  });

  onUnmounted(() => {
    window.removeEventListener('message', onWindowMessage);
    if (statePushTimer) clearTimeout(statePushTimer);
    api.unsubscribeEvents();
  });

  watch([view, resWin, focusQuarter], syncUrl);

  watch(teamId, (id) => {
    if (resumeLeft.value > 0 && resumeBusyTeamIds.value.includes(id)) {
      createJiraRunning.value = true;
    }
  });

  // Everything memory cares about, so an unrelated snapshot field does not
  // trigger a sync round-trip.
  const stateFingerprint = computed(() => JSON.stringify(postMessageState()));
  watch(stateFingerprint, () => schedulePushState());

  return {
    api,
    teams,
    snapshot,
    loading,
    activity,
    visibleActivity,
    activityOpen,
    nameGateOpen,
    popKeys,
    enterKey,
    newSubId,
    toasts,
    view,
    locate,
    locateReturn,
    locateInGantt,
    cancelLocate,
    returnFromLocate,
    resourceSelection,
    dependencyFilter,
    dependencyFocus,
    resWin,
    resOffset,
    focusQuarter,
    rulerMode,
    modals,
    msSel,
    msMode,
    msActive,
    hasMsData,
    milestones,
    msMatch,
    msLateOf,
    msStats,
    qSel,
    qActive,
    hasQData,
    qMatch,
    qOverOf,
    qCandidates,
    qCount,
    qOverCount,
    quickQuarters,
    setQSel,
    syncQuarterOptions,
    qOptSyncing,
    qOptFetchedAt,
    searchQuery,
    searchActive,
    filterActive,
    textMatch,
    viewMatch,
    setSearchQuery,
    // E-171 层级（Epic / INIT）
    hierarchy,
    isInit,
    setHierarchy,
    initMode,
    setInitMode,
    dimMode,
    initFold,
    toggleInitFold,
    inits,
    initInfo,
    initName,
    initShortName,
    initKeyCmp,
    initGroups,
    initStats,
    zeroHitInits,
    unpulledSelectedQuarters,
    // E-171 Committed = No
    ucOn,
    ucScopeText,
    itemUc,
    initUc,
    depCommittedText,
    msDictSyncing,
    msDictUpdatedAt,
    msDictStale,
    setMsSel,
    setMsMode,
    syncMilestoneDictionary,
    createJiraRunning,
    importOverwrite,
    teamId,
    editable,
    hasExtension,
    scheduledItems,
    backlogItems,
    jqlHints,
    hintsComplete,
    toast,
    loadTeams,
    selectTeam,
    applySnapshotFromIntent,
    applyOptimisticRemoval,
    applyPlanningReceipt,
    deferSubsToNextMonday,
    ensureActorName,
    expiredStats,
    draftItems,
    draftSubs,
    pendingImportQuarters,
    chipList,
    syncUrl,
    setItemExpanded,
    commitSnapshot,
    postMessageState,
    pushStateToExtension,
  };
}

export function provideRoadmapState() {
  const state = createRoadmapState();
  provide(ROADMAP_STATE_KEY, state);
  return state;
}

export function useRoadmapState() {
  const state = inject(ROADMAP_STATE_KEY);
  if (!state) throw new Error('useRoadmapState must be used within provider');
  return state;
}

export function scheduleFromBacklog(
  item: RoadmapItem,
  start: Date,
  days: number,
  lane: number,
) {
  return {
    op: 'schedule',
    itemKey: item.key,
    start: fmtISO(start),
    days,
    lane,
    baseVersion: item.version,
  };
}

export function itemEndDate(item: { start?: string | null; days?: number | null }) {
  if (!item.start || !item.days) return null;
  return addD(item.start, item.days - 1);
}

/**
 * Target 窗口：Backlog 表单可以只填 Target 结束（或只填开始），缺失的一侧用预估周数补出来。
 * 返回 null = 没有 Target，应当按拖放位置 + 预估排期。
 */
export function targetWindow(
  item: Pick<RoadmapItem, 'targetStart' | 'targetEnd' | 'estimate'>,
): { start: Date; end: Date; days: number } | null {
  const estDays = Math.max(7, (item.estimate || 3) * 7);
  const tStart = item.targetStart ? parseDate(item.targetStart) : null;
  const tEnd = item.targetEnd ? parseDate(item.targetEnd) : null;
  let start: Date;
  let end: Date;
  if (tStart && tEnd) {
    start = tStart;
    end = tEnd;
  } else if (tStart) {
    start = tStart;
    end = addD(start, estDays - 1);
  } else if (tEnd) {
    // 只填了 Target 结束：向前推预估长度，让 bar 落在结束日上，而不是丢掉结束日。
    end = tEnd;
    start = addD(end, -(estDays - 1));
  } else {
    return null;
  }
  if (end < start) end = start; // 结束早于开始的脏数据不倒挂
  return { start, end, days: diffD(start, end) + 1 };
}

/**
 * 把 Target 窗口收进可见时间轴：窗口整段可见时原样返回；越界时保持长度不变，把整段尽量
 * 靠向 Target 并压进时间轴内（绝不产生 days < 2 或落在时间轴外的 bar）。
 */
export function fitTargetWindow(
  win: { start: Date; end: Date; days: number },
  tlStart: Date,
  tlEnd: Date,
): { start: Date; days: number } {
  const tlDays = Math.max(2, diffD(tlStart, tlEnd) + 1);
  const days = Math.min(Math.max(2, win.days), tlDays);
  let end = win.end > tlEnd ? tlEnd : win.end;
  let start = addD(end, -(days - 1));
  if (start < tlStart) {
    start = tlStart;
    end = addD(start, days - 1);
    if (end > tlEnd) end = tlEnd;
  }
  return { start, days: Math.max(2, diffD(start, end) + 1) };
}
