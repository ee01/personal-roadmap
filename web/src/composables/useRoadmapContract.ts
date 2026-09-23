import type {
  ActivityEntry,
  JqlHints,
  PhaseKind,
  RoadmapItem,
  RoadmapMarker,
  RoadmapSub,
} from '../types';
// Keep the runtime import Node-ESM compatible: the extension's contract test
// imports this module directly, while Vite resolves the `.js` specifier to the
// TypeScript source during the web build.
import { addD, fmtISO, fmtMD, parseDate, qCmp } from './useGeometry.js';

/** ticker 忽略的低信息量操作（含已废弃的 expand/collapse） */
export const TICKER_NOISE_OPS = new Set([
  'lock',
  'unlock',
  'expand',
  'collapse',
  'refresh_from_jira',
]);

function isSilentReleaseSheetRefresh(entry: ActivityEntry): boolean {
  return entry.op === 'update_release_sheet' && !entry.summary?.cleared;
}

export function isSystemActivity(entry: ActivityEntry): boolean {
  return entry.actorSource === 'system' || Boolean(entry.summary?.silent);
}

/**
 * 取最新一条「其他人」的有效日志；没有则 null（ticker 隐藏）。
 * `activity` 假定按时间倒序（最新在前）。
 * 传入 `teamId` 时丢掉其他团队的串入事件；静默刷表（未清除）不当协作编辑。
 */
export function pickTickerEntry(
  activity: ActivityEntry[],
  selfClientId: string,
  teamId?: string,
): ActivityEntry | null {
  for (const entry of activity) {
    if (teamId && entry.teamId && entry.teamId !== teamId) continue;
    if (entry.actorClientId === selfClientId) continue;
    if (TICKER_NOISE_OPS.has(entry.op)) continue;
    if (isSilentReleaseSheetRefresh(entry)) continue;
    return entry;
  }
  return null;
}

/**
 * ticker 动作文案：去掉后端 text 里重复的 actor 名前缀，超长截断。
 * 主任务缩写已由服务端 `renderActivityText`（alias || title）写进 text。
 */
export function tickerLabel(entry: ActivityEntry, maxLen = 72): string {
  const who = String(entry.actorName || '').trim();
  let action = String(entry.text || '').trim();
  if (who && action.startsWith(who)) {
    action = action.slice(who.length).trimStart();
  }
  if (action.length <= maxLen) return action;
  return `${action.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Used when talking to a server that predates `team.jqlHints`. */
export const EMPTY_JQL_HINTS: JqlHints = {
  projectKey: null,
  itemType: null,
  subType: null,
  linkField: null,
  confident: false,
};

export const PHASE_DEFS: Record<
  PhaseKind,
  { label: string | null; glyph: string; color: string }
> = {
  design: { label: 'Design', glyph: 'D', color: '#6D4FA3' },
  stage: { label: 'Stage', glyph: 'S', color: '#0684BC' },
  production: { label: 'Production', glyph: 'P', color: '#2E8540' },
  custom: { label: null, glyph: '★', color: '#8B93A0' },
};

/** 缺 ETA 的依赖数（角标是否红色脉动） */
export function pendingDepCount(
  item: Pick<RoadmapItem, 'markers'>,
): number {
  return (item.markers || []).filter((m) => m.kind === 'dep' && !m.date).length;
}

/** ETA 与镜像的 Jira Target End 不一致（有 ETA 才算） */
export function depEtaMismatchesJira(m: RoadmapMarker): boolean {
  if (m.kind !== 'dep' || !m.jiraKey || !m.jiraTargetEnd || !m.date) return false;
  return m.date !== m.jiraTargetEnd;
}

/** Jira 有 Target End，且 Roadmap ETA 缺失或不一致时，可一键采用。 */
export function canAdoptJiraTargetEnd(m: RoadmapMarker): boolean {
  return Boolean(
    m.kind === 'dep' && m.jiraKey && m.jiraTargetEnd && m.date !== m.jiraTargetEnd,
  );
}

/** Adopt 按钮文案。无 Target End 时返回 null，避免 fmtMD(undefined) 把整层浮窗打空。 */
export function depAdoptLabel(
  m: Pick<RoadmapMarker, 'date' | 'jiraTargetEnd'>,
): string | null {
  if (!m.jiraTargetEnd) return null;
  return m.date
    ? `改用 Jira ${fmtMD(m.jiraTargetEnd)}`
    : `采用 ${fmtMD(m.jiraTargetEnd)} 为 ETA`;
}

export function driftedDepCount(
  item: Pick<RoadmapItem, 'markers'>,
): number {
  return (item.markers || []).filter(depEtaMismatchesJira).length;
}

/** Hover 第三段：只读提示，不承载确认按钮 */
export function depHoverHint(m: RoadmapMarker): string {
  const drag = '左右拖动改 ETA · 单击查看该依赖';
  if (!m.jiraKey) return `${drag} · 手动填写`;
  if (!m.date && m.jiraTargetEnd) {
    return `缺 ETA · Jira Target End ${fmtMD(m.jiraTargetEnd)} · 单击可同步`;
  }
  if (!m.date) {
    return m.jiraFetchedAt
      ? '缺 ETA · Jira 也无 Target End · 单击查看'
      : `${drag} · 尚未刷新 Jira`;
  }
  if (depEtaMismatchesJira(m)) {
    return `Jira Target End ${fmtMD(m.jiraTargetEnd!)} · 不一致 · 单击可同步`;
  }
  if (m.jiraTargetEnd) {
    return `与 Jira Target End 一致 · ${drag}`;
  }
  return drag;
}

/** Popover 上 Jira status 芯片。没有拉到 status 一律「未刷新」，刷新入口贴在芯片旁。 */
export function depStatusChipLabel(
  m: Pick<RoadmapMarker, 'jiraKey' | 'jiraStatus'>,
): string | null {
  if (!m.jiraKey) return null;
  return m.jiraStatus || '未刷新';
}

export function depStatusIsStale(
  m: Pick<RoadmapMarker, 'jiraKey' | 'jiraStatus'>,
): boolean {
  return Boolean(m.jiraKey && !m.jiraStatus);
}

export function depHoverTip(m: RoadmapMarker): string {
  const status = m.jiraStatus ? ` · ${m.jiraStatus}` : '';
  const keyBit = m.jiraKey ? ` · ${m.jiraKey}${status}` : ' · 手动填写';
  const head = m.date
    ? `外部依赖 ETA ${fmtMD(m.date)}${keyBit}`
    : `外部依赖${keyBit}`;
  return `${head}||${m.label}||${depHoverHint(m)}`;
}

export function depBadgeTip(item: Pick<RoadmapItem, 'markers'>): string {
  const deps = depMarkers(item);
  const n = deps.length;
  const pending = pendingDepCount(item);
  const drift = driftedDepCount(item);
  const canAdopt = deps.some((d) => d.jiraKey && !d.date && d.jiraTargetEnd);
  let head = `${n} 个外部依赖`;
  if (pending) head += ' · 有依赖缺少交付时间 ETA';
  else if (drift) head += ' · 有依赖 ETA 与 Jira Target End 不一致';
  let hint = '点击查看 / 添加外部依赖';
  if (canAdopt) hint = 'Jira 已有 Target End，单击可同步为 ETA';
  else if (drift) hint = '单击可改用 Jira Target End 或保留 Roadmap ETA';
  return `${head}||外部依赖||${hint}`;
}

/** 全部外部依赖（含无 ETA） */
export function depMarkers(item: Pick<RoadmapItem, 'markers'>): RoadmapMarker[] {
  return (item.markers || []).filter((m) => m.kind === 'dep');
}

/** 标记轨上可渲染的 markers（phase 全部 + 有 date 的 dep），按 date 升序 */
export function trackMarkers(
  item: Pick<RoadmapItem, 'markers'>,
): RoadmapMarker[] {
  return (item.markers || [])
    .filter((m) => m.kind === 'phase' || Boolean(m.date))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** 新 phase 的默认日期：bar end + 7 + phases.length*7（与 demo 一致） */
export function defaultPhaseDate(
  item: Pick<RoadmapItem, 'start' | 'days' | 'markers'>,
): string {
  const start = item.start ? parseDate(item.start) : new Date();
  const days = item.days || 1;
  const base = addD(start, days - 1);
  const phaseCount = (item.markers || []).filter((m) => m.kind === 'phase').length;
  return fmtISO(addD(base, 7 + phaseCount * 7));
}

export function phaseGlyph(marker: RoadmapMarker): string {
  if (marker.phaseKind === 'custom') {
    return (marker.label.trim()[0] || '★').toUpperCase();
  }
  return PHASE_DEFS[marker.phaseKind || 'custom']?.glyph || '★';
}

export function phaseColor(marker: RoadmapMarker): string {
  return PHASE_DEFS[marker.phaseKind || 'custom']?.color || '#8B93A0';
}

export function jiraBrowseUrl(jiraKey: string, base = 'https://jira.ringcentral.com'): string {
  return `${base.replace(/\/$/, '')}/browse/${encodeURIComponent(jiraKey)}`;
}

/**
 * An item is a draft exactly while no Jira issue exists for it.
 *
 * `source` must not be used for this: imported rows carry `source: 'jira'`, and
 * a hand-made row keeps `source: 'manual'` forever — including after its issue
 * has been created and `jiraKey` backfilled.
 */
export function isDraftItem(item: Pick<RoadmapItem, 'jiraKey'>): boolean {
  return !item.jiraKey;
}

/** The synthetic `LOCAL-…` key is an internal handle; show the Jira key once it exists. */
export function itemDisplayKey(item: Pick<RoadmapItem, 'jiraKey' | 'key'>): string {
  return item.jiraKey || item.key;
}

/** Manual items are the only ones the roadmap owns outright. */
export function canDeleteItem(
  item: Pick<RoadmapItem, 'source' | 'jiraKey'>,
): boolean {
  return item.source === 'manual' && !item.jiraKey;
}

/**
 * Aliases past this length are usually a preserved draft title (see
 * resolve_item/resolve_draft), not a hand-typed short display name — wrapping
 * those to multiple lines blows up the bar height for no benefit, so they get
 * single-line ellipsis like a plain title instead.
 */
export const ALIAS_WRAP_MAX_CHARS = 40;

export function shouldWrapAlias(alias: string | null | undefined): boolean {
  return Boolean(alias) && alias!.length <= ALIAS_WRAP_MAX_CHARS;
}

/**
 * Resource view shows only sub-tasks, so which Epic a bar belongs to isn't
 * visible from the row alone. Each Epic gets a stable color from its gantt
 * row position (not a hash of the key) so neighbors in the list get visibly
 * distinct colors instead of two dark blues next to each other.
 */
export const EPIC_PALETTE = [
  '#6D4FA3',
  '#0684BC',
  '#2E8540',
  '#C9842A',
  '#B8478D',
  '#4FA3A5',
  '#5B8DEF',
  '#C75B4A',
];

export function epicColor(orderedKeys: string[], key: string): string {
  const idx = orderedKeys.indexOf(key);
  const fallback = key.length;
  return EPIC_PALETTE[(idx >= 0 ? idx : fallback) % EPIC_PALETTE.length];
}

export function epicShort(item: Pick<RoadmapItem, 'alias' | 'title'>): string {
  return clipTxt(item.alias || item.title, 14);
}

/**
 * Jira workflow statuses treated as "done". Mirrored status can lag the local
 * schedule (an Epic or Task dated in the future may already be Closed), so it's
 * shown with its own color rather than folded into the past/current/future
 * palette. Finished Tasks are also excluded from defer candidates.
 */
export const DONE_STATUSES = new Set(['Closed', 'Resolved', 'Done']);

export function isDoneStatus(row: { status?: string | null }): boolean {
  return Boolean(row.status) && DONE_STATUSES.has(row.status!);
}

export function formatEstimate(estimate: number | null | undefined): string {
  return typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0
    ? `${estimate}w`
    : '—';
}

/** UI cap for user-entered draft descriptions (Prompt budget). */
export const DESCRIPTION_MAX_CHARS = 2000;

export function clipTxt(text: string | null | undefined, max: number): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max))}…`;
}

/** Gray-line slot of a `data-tip`: description when present, else the operation hint. */
export function tooltipHintLine(
  description: string | null | undefined,
  fallback: string,
): string {
  const clipped = clipTxt(description, 150);
  return clipped || fallback;
}

export function clampDescription(raw: string, max = DESCRIPTION_MAX_CHARS): string {
  return String(raw || '').slice(0, max);
}

/**
 * Badge class + label for an item type. The CSS classes are uppercase
 * (`.type-EPIC`), while the backend returns canonical Jira casing (`Epic`).
 */
export function typeBadge(type: string | null | undefined): {
  cls: string;
  label: string;
} {
  const raw = (type || '').trim();
  if (!raw) return { cls: 'type-TASK', label: '—' };
  const upper = raw.toUpperCase();
  const cls =
    upper === 'EPIC'
      ? 'type-EPIC'
      : upper === 'INITIATIVE' || upper === 'INIT'
        ? 'type-INIT'
        : 'type-TASK';
  const label = upper === 'INITIATIVE' ? 'INIT' : upper;
  return { cls, label };
}

/**
 * Mirrors `resolveSubType` in `roadmap-service/src/core/JqlIntrospect.ts`:
 * Initiative and Epic have a child type we can name up front (Epic / Task),
 * while anything at Task level takes a real sub-task whose name differs per
 * Jira project. For that case the backend deliberately sends `subType: null`
 * and the extension resolves the name from `createmeta`, so an empty sub-type
 * field must not block the create button.
 */
export function subTypeComesFromCreateMeta(
  itemType: string | null | undefined,
): boolean {
  const normalized = (itemType || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized !== 'initiative' && normalized !== 'init' && normalized !== 'epic'
  );
}

/**
 * Keys for open-page silent Jira refresh. Scheduled main/subs/dep tickets come
 * first; backlog epics with a jiraKey fill the same 50-key primary budget so
 * unscheduled rows can mirror status too.
 */
export function collectJiraRefreshKeys(
  scheduledItems: RoadmapItem[],
  backlogItems: RoadmapItem[],
  blockedKeys: ReadonlySet<string> = new Set(),
): string[] {
  const itemKeys: string[] = [];
  const depKeys: string[] = [];
  for (const it of scheduledItems) {
    if (it.jiraKey && !blockedKeys.has(it.jiraKey)) itemKeys.push(it.jiraKey);
    for (const s of it.subs) {
      if (s.cleared || !s.key || blockedKeys.has(s.key)) continue;
      itemKeys.push(s.key);
    }
    for (const m of it.markers || []) {
      if (m.kind !== 'dep' || !m.jiraKey || blockedKeys.has(m.jiraKey)) continue;
      depKeys.push(m.jiraKey);
    }
  }
  for (const it of backlogItems) {
    if (it.jiraKey && !blockedKeys.has(it.jiraKey)) itemKeys.push(it.jiraKey);
  }
  const primary = [...new Set(itemKeys)].slice(0, 50);
  const seen = new Set(primary);
  const extra = [...new Set(depKeys)].filter((k) => !seen.has(k)).slice(0, 25);
  return [...primary, ...extra];
}

/**
 * Inclusive Gantt end (`days` is a length). Null when the bar has no span.
 */
export function ganttEndIso(
  start: string | null | undefined,
  days: number | null | undefined,
): string | null {
  if (!start || typeof days !== 'number' || !Number.isFinite(days) || days < 1) {
    return null;
  }
  return fmtISO(addD(parseDate(start), Math.max(1, Math.floor(days)) - 1));
}

/**
 * True when the Gantt bar no longer matches the last mirrored Jira Target.
 * Missing both target fields means the row was never mirrored — do not treat
 * it as a pending Roadmap→Jira write.
 */
export function scheduleDivergesFromMirroredTarget(input: {
  start?: string | null;
  days?: number | null;
  targetStart?: string | null;
  targetEnd?: string | null;
}): boolean {
  const start = input.start || null;
  const days =
    typeof input.days === 'number' && Number.isFinite(input.days)
      ? Math.floor(input.days)
      : null;
  const targetStart = input.targetStart || null;
  const targetEnd = input.targetEnd || null;
  if (!start || !days || days < 1) return false;
  if (!targetStart && !targetEnd) return false;
  const end = ganttEndIso(start, days);
  if (targetStart && targetStart !== start) return true;
  if (targetEnd && end && targetEnd !== end) return true;
  return false;
}

export type UnsyncedTargetRef = {
  itemKey?: string;
  subId?: string;
  jiraKey: string;
  start: string;
  days: number;
};

/** Gantt rows whose local span diverges from last mirrored Jira Target. */
export function collectUnsyncedTargetRefs(
  items: RoadmapItem[],
): UnsyncedTargetRef[] {
  const out: UnsyncedTargetRef[] = [];
  for (const it of items) {
    if (
      it.scheduled &&
      it.jiraKey &&
      it.start &&
      typeof it.days === 'number' &&
      scheduleDivergesFromMirroredTarget({
        start: it.start,
        days: it.days,
        targetStart: it.targetStart,
        targetEnd: it.targetEnd,
      })
    ) {
      out.push({
        itemKey: it.key,
        jiraKey: it.jiraKey,
        start: it.start,
        days: it.days,
      });
    }
    for (const s of it.subs || []) {
      if (s.cleared || s.temp || !s.key || !s.start || typeof s.days !== 'number') {
        continue;
      }
      if (
        !scheduleDivergesFromMirroredTarget({
          start: s.start,
          days: s.days,
          targetStart: s.targetStart,
          targetEnd: s.targetEnd,
        })
      ) {
        continue;
      }
      out.push({
        subId: s.id,
        jiraKey: s.key,
        start: s.start,
        days: s.days,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Backlog ordering
 * ------------------------------------------------------------------ */

/** 分组标题：条目没填 quarter 时的归属。 */
export const NO_QUARTER_GROUP = '—';

function createdAtOf(item: Pick<RoadmapItem, 'createdAt'>): number {
  return typeof item.createdAt === 'number' ? item.createdAt : 0;
}

/** 没填 quarter 的分组排在所有季度之后。 */
function backlogQuarterCmp(a: string, b: string): number {
  if (a === b) return 0;
  if (a === NO_QUARTER_GROUP) return 1;
  if (b === NO_QUARTER_GROUP) return -1;
  return qCmp(a, b);
}

/**
 * Backlog 的分组与排序：新建的手动条目要出现在整个列表最前面。
 *
 * - 组内：`source='manual'` 的条目按创建时间倒序置顶，Jira 导入条目保持服务端
 *   的 `ORDER BY quarter, key` 原序排在其后
 * - 组间：含「最新手动条目」的那个 quarter 整组提到最前，其余分组仍按季度先后
 *
 * 只提升一个分组，所以列表首卡片必然是刚建出来的条目，其他季度的相对顺序不变。
 */
export function buildBacklogGroups(
  items: RoadmapItem[],
): Array<[string, RoadmapItem[]]> {
  const groups = new Map<string, RoadmapItem[]>();
  let leadQuarter: string | null = null;
  let leadAt = -Infinity;
  for (const item of items) {
    const quarter = item.quarter || NO_QUARTER_GROUP;
    const list = groups.get(quarter);
    if (list) list.push(item);
    else groups.set(quarter, [item]);
    if (item.source === 'manual' && createdAtOf(item) > leadAt) {
      leadAt = createdAtOf(item);
      leadQuarter = quarter;
    }
  }
  for (const list of groups.values()) {
    // Array#sort is stable, so Jira rows keep the incoming key order.
    list.sort((a, b) => {
      const doneCmp = Number(isDoneStatus(a)) - Number(isDoneStatus(b));
      if (doneCmp !== 0) return doneCmp;
      if (a.source !== b.source) return a.source === 'manual' ? -1 : 1;
      if (a.source !== 'manual') return 0;
      return createdAtOf(b) - createdAtOf(a);
    });
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === leadQuarter) return -1;
    if (b === leadQuarter) return 1;
    return backlogQuarterCmp(a, b);
  });
}

/* ------------------------------------------------------------------ *
 * postMessage state contract (consumed by the extension content script)
 * ------------------------------------------------------------------ */

export interface RoadmapStateItem {
  key: string;
  type: string;
  title: string;
  alias: string | null;
  quarter: string;
  targetStart: string | null;
  targetEnd: string | null;
  start: string | null;
  days: number | null;
  isDraft: boolean;
  jiraKey: string | null;
  subActivity: boolean;
  description?: string | null;
}

export interface RoadmapStateMessage {
  type: 'pai-roadmap-state';
  teamId: string | null;
  /** Legacy alias of `teamId`, kept so older extension builds keep working. */
  team: string | null;
  teamName: string | null;
  quarter: string;
  editable: boolean;
  items: RoadmapStateItem[];
}

export function toStateItem(
  item: RoadmapItem,
  fallbackQuarter: string,
): RoadmapStateItem {
  return {
    key: item.key,
    type: item.type,
    title: item.title,
    alias: item.alias ?? null,
    quarter: item.quarter || fallbackQuarter,
    targetStart: item.targetStart ?? null,
    targetEnd: item.targetEnd ?? null,
    start: item.start ?? null,
    days: item.days ?? null,
    isDraft: isDraftItem(item),
    jiraKey: item.jiraKey ?? null,
    subActivity: item.subs.length > 0,
    description:
      [
        item.description,
        ...item.subs
          .filter((s) => !s.cleared && s.description)
          .map((s) => s.description),
      ]
        .filter(Boolean)
        .join('\n') || null,
  };
}

export function buildStateMessage(input: {
  teamId: string | null;
  teamName: string | null;
  quarter: string;
  editable: boolean;
  items: RoadmapItem[];
}): RoadmapStateMessage {
  return {
    type: 'pai-roadmap-state',
    teamId: input.teamId,
    team: input.teamId,
    teamName: input.teamName,
    quarter: input.quarter,
    editable: input.editable,
    items: input.items.map((item) => toStateItem(item, input.quarter)),
  };
}

/* ------------------------------------------------------------------ *
 * Two-phase Jira creation contract
 * ------------------------------------------------------------------ */

export interface CreateJiraParent {
  itemKey: string;
  title: string;
  issueType: string;
  projectKey: string;
  targetStart: string | null;
  targetEnd: string | null;
  /** Uniform override, or per-row landing when the shared field is empty. */
  fixVersion?: string | null;
  /** Target End 落点列；Agent 在共享字段留空时按此分别填写。 */
  suggestedFixVersion?: string | null;
  description?: string | null;
}

export interface CreateJiraChild {
  draftId: string;
  title: string;
  issueType: string;
  projectKey: string;
  parentItemKey: string;
  /** Set when the parent issue already exists, so the extension can link right away. */
  parentJiraKey: string | null;
  fixVersion?: string | null;
  suggestedFixVersion?: string | null;
  /** Jira username (firstname.lastname); omit / null → leave assignee empty. */
  assignee?: string | null;
  description?: string | null;
}

export interface CreateJiraPayload {
  teamId: string;
  token: string | null;
  parent: CreateJiraParent | null;
  children: CreateJiraChild[];
}

export interface CreateJiraResult {
  parent?: {
    itemKey: string;
    jiraKey?: string;
    error?: string;
    warnings?: string[];
  };
  children: Array<{
    draftId: string;
    jiraKey?: string;
    error?: string;
    warnings?: string[];
  }>;
}

export interface AgentCreateConstraints {
  projectKey?: string | null;
  issueType?: string | null;
  subType?: string | null;
  fixVersion?: string | null;
  sprint?: string | null;
}

export interface AgentCreateJiraPayload {
  teamId: string;
  token: string | null;
  prompt: string;
  executor: string;
  teamName?: string | null;
  constraints: AgentCreateConstraints;
  parent: CreateJiraParent | null;
  children: CreateJiraChild[];
  /**
   * Incremented on each retry of remaining drafts. A succeeded / input_required
   * AgentTask is reused by the same idempotency key, so retries that need a
   * new prompt (e.g. user changed fixVersion) must not collide with the old run.
   */
  retryAttempt?: number | null;
}

/** One main item plus the draft children waiting on it. */
export interface DraftGroup {
  item: RoadmapItem;
  subs: RoadmapSub[];
}

/**
 * Group every pending creation by main item: a draft main item (with or without
 * children) or an already-created main item that has draft children left.
 */
export function buildDraftGroups(items: RoadmapItem[]): DraftGroup[] {
  const groups: DraftGroup[] = [];
  for (const item of items) {
    const subs = item.subs.filter((s) => s.temp && !s.cleared);
    if (!subs.length && !isDraftItem(item)) continue;
    groups.push({ item, subs });
  }
  return groups;
}

export function buildCreateJiraPayload(
  group: DraftGroup,
  fields: {
    teamId: string;
    token: string | null;
    projectKey: string;
    issueType: string;
    subType: string;
    /** Uniform override applied to every row when set. */
    fixVersionOverride?: string | null;
    /** Per-row suggested Fix Version (Target End → release sheet). */
    fixVersionByKey?: Record<string, string | null | undefined>;
    /** Per-child Jira username (firstname.lastname). */
    assigneeByDraftId?: Record<string, string | null | undefined>;
  },
): CreateJiraPayload {
  const parentIsDraft = isDraftItem(group.item);
  const override = String(fields.fixVersionOverride || '').trim() || null;
  const parentSuggested =
    fields.fixVersionByKey?.[group.item.key] ?? null;
  return {
    teamId: fields.teamId,
    token: fields.token,
    parent: parentIsDraft
      ? {
          itemKey: group.item.key,
          title: group.item.title,
          issueType: fields.issueType,
          projectKey: fields.projectKey,
          targetStart: group.item.targetStart ?? null,
          targetEnd: group.item.targetEnd ?? null,
          fixVersion: override || parentSuggested || null,
          suggestedFixVersion: parentSuggested || null,
          description: group.item.description ?? null,
        }
      : null,
    children: group.subs.map((sub) => {
      const suggested = fields.fixVersionByKey?.[sub.id] || null;
      return {
        draftId: sub.id,
        title: sub.title,
        issueType: fields.subType,
        projectKey: fields.projectKey,
        parentItemKey: group.item.key,
        parentJiraKey: group.item.jiraKey ?? null,
        fixVersion: override || suggested,
        suggestedFixVersion: suggested,
        assignee: fields.assigneeByDraftId?.[sub.id] || null,
        description: sub.description ?? null,
      };
    }),
  };
}

export type CreateRowStatusLite = {
  kind: 'pending' | 'loading' | 'ok' | 'error';
  jiraKey?: string;
};

export function createItemRowId(itemKey: string): string {
  return `item:${itemKey}`;
}

export function createSubRowId(subId: string): string {
  return `sub:${subId}`;
}

function statusJiraKey(
  status: CreateRowStatusLite | undefined,
): string | undefined {
  const key = String(status?.jiraKey || '').trim();
  return key || undefined;
}

/**
 * Drop already-created rows from a retry payload. A jiraKey on the item, or on
 * the row status (including writeback warnings), means that issue already
 * exists — sending it again would duplicate the ticket.
 */
export function sliceDraftGroupForRetry(
  group: DraftGroup,
  rowStatus: Record<string, CreateRowStatusLite | undefined>,
): DraftGroup | null {
  const parentStatus = rowStatus[createItemRowId(group.item.key)];
  const parentJiraKey =
    String(group.item.jiraKey || '').trim() ||
    statusJiraKey(parentStatus) ||
    '';

  const remainingSubs = group.subs.filter((sub) => {
    const status = rowStatus[createSubRowId(sub.id)];
    if (statusJiraKey(status) || status?.kind === 'ok') return false;
    return true;
  });

  if (parentJiraKey && remainingSubs.length === 0) return null;

  return {
    item: parentJiraKey
      ? { ...group.item, jiraKey: parentJiraKey }
      : group.item,
    subs: remainingSubs,
  };
}

/** True when this group has a failed row that still has no Jira key. */
export function draftGroupCanRetry(
  group: DraftGroup,
  rowStatus: Record<string, CreateRowStatusLite | undefined>,
): boolean {
  const parentStatus = rowStatus[createItemRowId(group.item.key)];
  if (parentStatus?.kind === 'error' && !statusJiraKey(parentStatus)) {
    return true;
  }
  return group.subs.some((sub) => {
    const status = rowStatus[createSubRowId(sub.id)];
    return status?.kind === 'error' && !statusJiraKey(status);
  });
}
