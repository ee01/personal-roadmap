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
  ResWindow,
  RoadmapItem,
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
  parseDate,
  today,
} from './useGeometry';
import { useRoadmapApi } from './useRoadmapApi';

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
  target_start_required: '缺少目标日期',
};

export function intentErrorText(error?: string | null): string {
  const key = String(error || '');
  return INTENT_ERROR_TEXT[key] || `操作失败：${key || 'unknown'}`;
}

export function createRoadmapState() {
  const api = useRoadmapApi();

  const teams = ref<TeamSummary[]>([]);
  const snapshot = shallowRef<TeamSnapshot | null>(null);
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
  const resWin = ref<ResWindow>('2w');
  const focusQuarter = ref(CURQ);
  /** Session-only Sprint↔month toggle; not persisted / not synced. */
  const rulerMode = ref<RulerMode>('release');

  const modals = ref({
    team: false,
    jql: false,
    import: false,
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

  function commitSnapshot(snap: TeamSnapshot) {
    snapshot.value = overlayExpand(snap);
  }

  function setItemExpanded(key: string, open: boolean) {
    const next = new Set(expandedKeys.value);
    if (open) next.add(key);
    else next.delete(key);
    expandedKeys.value = next;
    if (snapshot.value) {
      snapshot.value = overlayExpand(snapshot.value);
    }
    syncUrl();
  }

  function syncUrl() {
    if (!teamId.value) return;
    const p = new URLSearchParams();
    p.set('team', teamId.value);
    if (focusQuarter.value) p.set('q', focusQuarter.value);
    if (view.value !== 'gantt') p.set('view', view.value);
    const scheduledKeys = new Set(scheduledItems.value.map((i) => i.key));
    const expanded = [...expandedKeys.value].filter((k) => scheduledKeys.has(k));
    if (expanded.length) p.set('expand', expanded.join(','));
    if (view.value === 'resource' && resWin.value !== '2w') p.set('w', resWin.value);
    const url = `${location.pathname}?${p.toString()}`;
    history.replaceState(null, '', url);
  }

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
      focusQuarter.value = readUrlParams().q || CURQ;
      view.value = readUrlParams().view || 'gantt';
      resWin.value = readUrlParams().w || '2w';
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
    if (snapshot.value) snapshot.value = overlayExpand(snapshot.value);
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
            snapshot.value = snap;
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
    resWin,
    focusQuarter,
    rulerMode,
    modals,
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
