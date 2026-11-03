<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoadmapState, QUARTER_NONE, INIT_NONE, initKeyOf } from '../composables/useRoadmapState';
import {
  buildBacklogGroups,
  canDeleteItem,
  formatEstimate,
  isDraftItem,
  isDoneStatus,
  itemDisplayKey,
  jiraBrowseUrl,
  typeBadge,
  tooltipHintLine,
  DESCRIPTION_MAX_CHARS,
  parseParentLinkInput,
} from '../composables/useRoadmapContract';
import { CURQ, chipList, diffD, esc, fmtMD, initials, jqlHasTargetDeliveryQuarter, parseDate, qCmp, today } from '../composables/useGeometry';
import { memberChipHtml, openOwnerFloat } from '../composables/useOwnerFloat';
import { dispName, teamAssigneeMap } from '../composables/useAssigneeMap';
import { bridgeImportJql } from '../composables/useExtensionBridge';
import { extensionLockTip, useExtensionGate } from '../composables/useExtensionGate';
import type { MilestoneValue, RoadmapItem, TeamMember } from '../types';
import DraftPlanningModal from './modals/DraftPlanningModal.vue';

const state = useRoadmapState();
const gate = useExtensionGate();
const addMode = ref<'manual' | 'ai'>('manual');

const jiraBase = computed(
  () => state.snapshot.value?.team.jiraBaseUrl || 'https://jira.ringcentral.com',
);
function browseUrl(key: string) {
  return jiraBrowseUrl(key, jiraBase.value);
}

const assigneeMap = computed(() => teamAssigneeMap(state.snapshot.value));
function showName(name: string | null | undefined) {
  return dispName(assigneeMap.value, name);
}
function memberColor(name: string | null | undefined) {
  return members.value.find((m) => m.name === name)?.avatarColor || '#8895A5';
}
const members = computed(() => state.snapshot.value?.members || []);
const assigneeMember = computed<TeamMember | null>(() => {
  const name = form.value.owner.trim();
  if (!name) return null;
  return (
    members.value.find((m) => m.name === name) || {
      id: '',
      name,
      avatarColor: '#8895A5',
    }
  );
});

function openAssignee(chip: HTMLElement) {
  openOwnerFloat(
    chip,
    members.value,
    form.value.owner || null,
    (member) => {
      form.value.owner = member?.name || '';
    },
    { allowClear: true, assigneeMap: assigneeMap.value, clearLabel: '移除 Assignee' },
  );
}

/** 过滤状态在顶部过滤行（milestone + 文本），Backlog 与甘特共用同一个谓词。 */
const filteredBacklog = computed(() =>
  state.backlogItems.value.filter((it) => state.viewMatch(it)),
);
const searchText = computed(() => state.searchQuery.value.trim());

const groups = computed(() => buildBacklogGroups(filteredBacklog.value));

/* ---------- 从 Jira 拉取（Backlog 头部入口 + 浮层） ----------
   Quarter 是「数据源 JQL 的参数」，和 JQL、导入动作放在一起；锄定在 Backlog——
   结果落在哪，入口就在哪。 */
const team = computed(() => state.snapshot.value?.team);
const overwrite = state.importOverwrite;
const hasQuarterField = computed(() =>
  jqlHasTargetDeliveryQuarter(team.value?.jql || ''),
);
const chips = computed(() => chipList(team.value?.checkedQuarters || [CURQ]));
const pending = computed(() =>
  state.pendingImportQuarters(
    team.value?.checkedQuarters || [],
    team.value?.importedQuarters || [],
  ),
);
const syncOpen = ref(false);
const syncShown = ref(false);
const importing = ref(false);
const syncBtnEl = ref<HTMLElement | null>(null);
const syncPopEl = ref<HTMLElement | null>(null);

const showPullBtn = computed(() => {
  if (!hasQuarterField.value) return Boolean(team.value?.jql?.trim());
  if (!team.value?.checkedQuarters.length) return false;
  return pending.value.length > 0 || overwrite.value;
});

const pullBtnLabel = computed(() => {
  if (!hasQuarterField.value) return '拉取';
  if (!showPullBtn.value) {
    return team.value?.checkedQuarters.length ? '已是最新' : '先选择 quarter';
  }
  return overwrite.value ? '重新拉取' : '拉取';
});

const pullQs = computed(() => {
  if (!team.value || !hasQuarterField.value) return [] as string[];
  return overwrite.value ? team.value.checkedQuarters : pending.value;
});

const syncSub = computed(() => {
  const imported = team.value?.importedQuarters || [];
  if (!imported.length) return '尚未拉取任何 quarter · 勾选后按团队 JQL 导入';
  const pend = pending.value;
  return `已拉取 ${imported.join(' / ')}${
    pend.length ? ` · 待拉取 ${pend.join(' / ')}` : ''
  }`;
});

async function toggleQuarter(q: string) {
  if (!team.value || !state.editable.value) return;
  const checked = [...team.value.checkedQuarters];
  const on = checked.includes(q);
  const next = on ? checked.filter((x) => x !== q) : [...checked, q].sort(qCmp);
  await state.applySnapshotFromIntent({
    op: 'set_quarters',
    checkedQuarters: next,
  });
}

function openSyncPop() {
  syncOpen.value = true;
  requestAnimationFrame(() => {
    placeSyncPop();
    syncShown.value = true;
  });
}

function closeSyncPop(refocus?: boolean) {
  syncOpen.value = false;
  syncShown.value = false;
  if (refocus) syncBtnEl.value?.focus();
}

function placeSyncPop() {
  const pop = syncPopEl.value;
  if (!pop || !syncBtnEl.value) return;
  const r = syncBtnEl.value.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left - 12, window.innerWidth - 372))}px`;
}

function onSyncOutsidePointerDown(ev: PointerEvent) {
  if (!syncOpen.value) return;
  const target = ev.target as HTMLElement | null;
  if (target?.closest('.sync-pop, .bl-sync, .bl-empty-link')) return;
  closeSyncPop();
}

function onSyncResize() {
  if (syncOpen.value) placeSyncPop();
}

function onSyncKeydown(ev: KeyboardEvent) {
  if (!syncOpen.value) return;
  if (ev.key === 'Escape') {
    ev.stopPropagation();
    closeSyncPop(true);
  }
}

async function runPull() {
  if (!team.value || !state.editable.value || importing.value) return;
  if (!state.hasExtension.value) {
    gate.openGate('import');
    return;
  }
  if (hasQuarterField.value && !pullQs.value.length) return;
  importing.value = true;
  try {
    const items = await bridgeImportJql(team.value.jql, pullQs.value);
    if (!items.length) {
      state.toast('Jira 未返回任何 issue，请检查 JQL / Quarter / Token');
      return;
    }
    await state.applySnapshotFromIntent({
      op: 'import',
      quarters: pullQs.value,
      overwrite: overwrite.value,
      checkedQuarters: team.value.checkedQuarters,
      items,
      // 顺带拉到的父 INIT 详情（标题 / 自身 Quarter / 自身 Committed）→ 服务端缓存
      inits,
    });
    closeSyncPop();
    state.toast(`<span class="ok">✓</span> 已拉取 <b>${items.length}</b> 个 issue → Backlog`);
    // 拉取时强制刷新 milestone 字典（名称 / 日期 / 描述可能变了）
    void state.syncMilestoneDictionary({ force: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '拉取失败';
    state.toast(`拉取失败：${message}`);
  } finally {
    importing.value = false;
  }
}

const imported = computed(
  () => (state.snapshot.value?.team.importedQuarters.length || 0) > 0,
);

const quarterOptions = computed(() => {
  const checked = state.snapshot.value?.team.checkedQuarters || [];
  return checked.includes(CURQ) ? checked : [CURQ, ...checked];
});

const addOpen = ref(false);
const saving = ref(false);
const bodyEl = ref<HTMLElement | null>(null);
const form = ref({
  title: '',
  type: '',
  quarter: CURQ,
  estimate: '' as string,
  targetStart: '',
  targetEnd: '',
  description: '',
  parentLink: '',
  owner: '',
});

function openAdd() {
  if (!state.editable.value) return;
  form.value = {
    title: '',
    type: state.jqlHints.value.itemType || '',
    quarter: state.focusQuarter.value || CURQ,
    estimate: '',
    targetStart: '',
    targetEnd: '',
    description: '',
    parentLink: '',
    owner: '',
  };
  addOpen.value = true;
  nextTick(() => {
    (document.querySelector('.add-item-modal input') as HTMLInputElement)?.focus();
  });
}

async function submitAdd() {
  const title = form.value.title.trim();
  if (!title || saving.value) return;
  const parentLink = parseParentLinkInput(form.value.parentLink);
  if (!parentLink.ok) {
    state.toast('Parent Link 需要是 Jira issue key，例如 INIT-123');
    return;
  }
  const estimate = Number(form.value.estimate);
  saving.value = true;
  try {
    await state.applySnapshotFromIntent({
      op: 'add_item',
      title,
      type: form.value.type.trim() || undefined,
      quarter: form.value.quarter || undefined,
      estimate: Number.isFinite(estimate) && estimate > 0 ? estimate : undefined,
      targetStart: form.value.targetStart || undefined,
      targetEnd: form.value.targetEnd || undefined,
      description: form.value.description.trim() || undefined,
      parentLink: parentLink.value || undefined,
      owner: form.value.owner.trim() || undefined,
    });
    addOpen.value = false;
    state.toast(`<span class="ok">✓</span> 已新建条目 <b>${esc(title)}</b>`);
    // 新条目排在列表首位，滚回顶部才看得见
    state.setSearchQuery('');
    await nextTick();
    bodyEl.value?.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    /* toast handled centrally */
  } finally {
    saving.value = false;
  }
}

async function removeItem(item: RoadmapItem) {
  if (!state.editable.value || !canDeleteItem(item)) return;
  try {
    await state.applyOptimisticRemoval(
      { kind: 'delete', itemKey: item.key },
      { op: 'delete_item', itemKey: item.key },
    );
    state.toast(`已删除条目 ${item.title}`);
  } catch {
    /* toast handled centrally; the row is put back when the intent fails */
  }
}

/* ---------- Milestone 标签（卡片上） ----------
   命中的排在前面；最多展示 2 个，其余折叠为 +N。Target End 晚于 milestone
   时标红「晚 Nd」——拖入时间轴前就值得留意。 */
function msShort(ms: MilestoneValue): string {
  return ms.name.length > 22 ? `${ms.name.slice(0, 21)}…` : ms.name;
}

function itemMsList(item: RoadmapItem): MilestoneValue[] {
  return (item.ms || [])
    .map((key) => state.milestones.value.find((m) => m.key === key))
    .filter((m): m is MilestoneValue => Boolean(m));
}

function sortedCardMs(item: RoadmapItem): MilestoneValue[] {
  const sel = state.msSel.value;
  return [...itemMsList(item)].sort(
    (a, b) =>
      Number(sel.includes(b.key)) - Number(sel.includes(a.key)),
  );
}

function cardMsLate(item: RoadmapItem, ms: MilestoneValue): number {
  if (!item.targetEnd || !ms.milestoneDate) return 0;
  return Math.max(0, diffD(parseDate(ms.milestoneDate), parseDate(item.targetEnd)));
}

function cardMsTip(item: RoadmapItem, ms: MilestoneValue): string {
  const late = cardMsLate(item, ms);
  const date = ms.milestoneDate ? parseDate(ms.milestoneDate) : null;
  const rel =
    late > 0
      ? `Jira Target End ${fmtMD(item.targetEnd!)} 晚于 milestone ${late} 天，拖入时间轴前就值得留意`
      : date
        ? diffD(today, date) >= 0
          ? `Milestone ${fmtMD(date)} · ${diffD(today, date)} 天后`
          : `Milestone ${fmtMD(date)} · ${-diffD(today, date)} 天前`
        : '日期未写在 description 首行，详见 milestone 描述';
  return `${esc(ms.key)} · ${
    ms.milestoneDate ? `Milestone ${fmtMD(ms.milestoneDate)}` : '日期未识别'
  }||${esc(ms.name)}||${rel}`;
}

function msSelNames(): string {
  return state.msSel.value
    .map((k) => state.milestones.value.find((m) => m.key === k)?.name || k)
    .join(' / ');
}

/* ---------- Quarter 超界标注（卡片上） ----------
   Quarter 过滤开启且该条目的结束日（未排期 = Jira Target End）超出其
   Target Delivery Quarter 时标红，拖入时间轴前就值得留意。 */
function cardQOver(item: RoadmapItem) {
  return state.qOverOf(item);
}

function cardQTip(item: RoadmapItem): string {
  const ov = cardQOver(item);
  if (!ov) return '';
  return `Target Delivery Quarter ${ov.q} · 截止 ${fmtMD(ov.qEnd)}||Jira Target End ${fmtMD(ov.end)}，超出 ${ov.q} ${ov.days} 天||要么把 Target End 收回到 ${fmtMD(ov.qEnd)} 之前，要么把 Quarter 改到下一季`;
}

/** 分组头上的超界计数（仅过滤开启时该组选中的 Quarter 有超界条目时显示）。 */
function groupQOver(q: string): number {
  return filteredBacklog.value.filter(
    (it) => (it.quarter || QUARTER_NONE) === q && state.qOverOf(it),
  ).length;
}

/* ---------- Committed = No（E-171，卡片自身字段） ---------- */
function cardUc(item: RoadmapItem): boolean {
  return state.itemUc(item);
}

function cardUcTip(item: RoadmapItem): string {
  const who = itemDisplayKey(item);
  return `${who} · Committed: No||${who} 自身的 Committed 字段为 No，且在 ${state.ucScopeText()} 范围内||只看这条 Epic 自身的字段，不受子任务或依赖影响 · 与 Owner 确认是否 commit`;
}

/** 分组头上的「N 项 Committed: No」计数（Epic 层级，只统计 Epic 自身字段）。 */
function groupUc(q: string): number {
  return filteredBacklog.value.filter(
    (it) => (it.quarter || QUARTER_NONE) === q && state.itemUc(it),
  ).length;
}

/* ---------- 层级（E-171）：Backlog 的 INIT 分组 ----------
   Backlog 与甘特共用同一命中集合（viewMatch，按 Epic 判断）；INIT 只是父级上下文：
   同一 INIT 可以同时出现在 Backlog（待排期 Epic）与甘特（已排期 Epic），不是重复排期。 */
interface BlInitStats {
  all: RoadmapItem[];
  hit: RoadmapItem[];
  sched: RoadmapItem[];
  back: RoadmapItem[];
}

type BlRenderOp =
  | { kind: 'qlabel'; id: string; label: string; qOver: number; uc: number }
  | { kind: 'inithead'; id: string; initKey: string; items: RoadmapItem[]; stats: BlInitStats }
  | { kind: 'initqlabel'; id: string; label: string }
  | { kind: 'initfoot'; id: string; allSched: string[]; zero: string[] }
  | { kind: 'card'; id: string; item: RoadmapItem };

/** 过滤口径名（组头计数前缀）：Quarter / Milestone / 搜索。 */
function scopeLabel(): string {
  return [
    state.qActive.value ? state.qSel.value.join('/') : '',
    state.msActive.value ? 'Milestone' : '',
    state.searchActive.value ? '搜索' : '',
  ]
    .filter(Boolean)
    .join(' + ');
}

function initHitCountTip(stats: BlInitStats): string {
  const label = scopeLabel();
  return label
    ? `${label} 命中 ${stats.hit.length} 个 Epic||分母是当前团队「已加载」的子 Epic 数，不代表 INIT 在 Jira 中的全部 Epic`
    : `已加载 ${stats.all.length} 个子 Epic||只统计当前团队已拉取的数据，不代表 INIT 在 Jira 中的全部 Epic`;
}

function initUcTip(key: string): string {
  return `${key} · Committed: No||${key} 自身的 Committed 字段为 No，且在 ${state.ucScopeText()} 范围内||INIT 行只读 INIT 自身的字段，不从子 Epic 或依赖推导 · 与 Owner 确认是否 commit`;
}

function initKeyTip(key: string): string {
  const info = state.initInfo(key);
  return info.loaded
    ? `${key} · INIT 自身 Quarter ${info.quarter || '未设置'}||${info.title || ''}||INIT 自身的 Quarter 仅作参考，不参与筛选；筛选按子 Epic 的 Target Delivery Quarter`
    : '';
}

/** 统一的渲染指令列表：Epic 层级按 Quarter 分组；INIT 层级按 Parent Link 分组，
 * 组内再按 Quarter 分小组；折叠的 INIT 只渲染组头。卡片本身只有一份标记。 */
const renderOps = computed<BlRenderOp[]>(() => {
  if (!filteredBacklog.value.length) return [];
  const ops: BlRenderOp[] = [];
  if (!state.isInit.value) {
    for (const [q, items] of groups.value) {
      ops.push({ kind: 'qlabel', id: `q:${q}`, label: q, qOver: groupQOver(q), uc: groupUc(q) });
      for (const it of items) ops.push({ kind: 'card', id: it.key, item: it });
    }
    return ops;
  }
  const byInit = state.initGroups(filteredBacklog.value);
  const keys = [...byInit.keys()].sort(state.initKeyCmp);
  for (const k of keys) {
    const items = byInit.get(k)!;
    ops.push({ kind: 'inithead', id: `init:${k}`, initKey: k, items, stats: state.initStats(k) });
    if (state.initFold.value.bl.has(k)) continue; // 折叠：只渲染组头
    const byQ = new Map<string, RoadmapItem[]>();
    for (const it of items) {
      const q = it.quarter || QUARTER_NONE;
      const list = byQ.get(q);
      if (list) list.push(it);
      else byQ.set(q, [it]);
    }
    const multi = byQ.size > 1;
    for (const [q, sub] of [...byQ.entries()].sort(
      ([a], [b]) => (a === QUARTER_NONE ? 1 : b === QUARTER_NONE ? -1 : qCmp(a, b)),
    )) {
      if (multi) ops.push({ kind: 'initqlabel', id: `initq:${k}:${q}`, label: q });
      for (const it of sub) ops.push({ kind: 'card', id: it.key, item: it });
    }
  }
  // 底部说明：命中 Epic 已全部排期、只剩甘特侧有组头的 INIT + 0 命中未显示的 INIT
  const shown = new Set(keys);
  const allSched = [
    ...new Set(
      state.scheduledItems.value.filter((i) => state.viewMatch(i)).map(initKeyOf),
    ),
  ]
    .filter((k) => !shown.has(k))
    .sort(state.initKeyCmp);
  const zero = state.zeroHitInits().filter((k) => !shown.has(k) && !allSched.includes(k));
  if (allSched.length || zero.length) {
    ops.push({ kind: 'initfoot', id: 'initfoot', allSched, zero });
  }
  return ops;
});

function toggleBlInit(key: string) {
  state.toggleInitFold('bl', key);
}

/** 组头互跳：Backlog ↔ 甘特的同一个 INIT。经 window 事件解耦两个面板。 */
function jumpToGanttInit(key: string) {
  window.dispatchEvent(
    new CustomEvent('roadmap-init-jump', { detail: { key, side: 'gantt' } }),
  );
}

function onInitJump(ev: Event) {
  const detail = (ev as CustomEvent<{ key?: string; side?: string }>).detail;
  if (detail?.side !== 'backlog' || !detail.key) return;
  if (state.initFold.value.bl.has(detail.key)) state.toggleInitFold('bl', detail.key);
  void nextTick(() => {
    const el = bodyEl.value?.querySelector(
      `.bl-init[data-init="${CSS.escape(detail.key!)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1700);
  });
}

/* 所选 Quarter 一个条目都没有、也没拉取过 → 「尚未拉取」而非「无匹配」。 */
const unpulled = computed(() => state.unpulledSelectedQuarters());

async function pullUnpulled() {
  const checked = team.value?.checkedQuarters || [];
  const next = [...new Set([...checked, ...unpulled.value])].sort(qCmp);
  if (next.length !== checked.length) {
    await state.applySnapshotFromIntent({ op: 'set_quarters', checkedQuarters: next });
  }
  openSyncPop();
}

function qSelNames(): string {
  return [...state.qSel.value].sort((a, b) =>
    a === QUARTER_NONE ? 1 : b === QUARTER_NONE ? -1 : qCmp(a, b),
  ).join(' / ');
}

function cardTipHead(item: RoadmapItem) {
  const bits = [
    itemDisplayKey(item),
    `预估 ${formatEstimate(item.estimate)}`,
    item.parentLink ? `Parent ${item.parentLink}` : '',
    item.owner ? `Assignee ${showName(item.owner)}` : '',
    item.targetStart || item.targetEnd ? '' : '无 Target 日期',
    isDoneStatus(item) ? item.status : '',
  ].filter(Boolean);
  return bits.join(' · ');
}

/** Target 只填了一侧也要能显示（缺的一侧用 — 占位，不能让 fmtMD(null) 崩掉整个 Backlog）。 */
function targetLabel(item: RoadmapItem) {
  const from = item.targetStart ? fmtMD(item.targetStart) : '—';
  const to = item.targetEnd ? fmtMD(item.targetEnd) : '—';
  return `Target ${from} → ${to}`;
}

function onCardPointerDown(e: PointerEvent, item: RoadmapItem) {
  if (!state.editable.value) return;
  if ((e.target as HTMLElement).closest('.card-del, .bar-link')) return;
  window.dispatchEvent(
    new CustomEvent('roadmap-card-drag-start', {
      detail: { event: e, item },
    }),
  );
}

function clearSearch() {
  state.setSearchQuery('');
}

function onPlanningCommitted() {
  state.setSearchQuery('');
  addOpen.value = false;
}

onMounted(() => {
  window.addEventListener('roadmap-planning-committed', onPlanningCommitted);
  window.addEventListener('roadmap-init-jump', onInitJump);
  document.addEventListener('pointerdown', onSyncOutsidePointerDown, true);
  document.addEventListener('keydown', onSyncKeydown, true);
  window.addEventListener('resize', onSyncResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('roadmap-planning-committed', onPlanningCommitted);
  window.removeEventListener('roadmap-init-jump', onInitJump);
  document.removeEventListener('pointerdown', onSyncOutsidePointerDown, true);
  document.removeEventListener('keydown', onSyncKeydown, true);
  window.removeEventListener('resize', onSyncResize);
});
</script>

<template>
  <aside class="backlog">
    <div class="bl-head">
      <div class="bl-title">
        Backlog
        <span
          class="bl-count"
          :class="{ 'ms-on': state.msActive.value, 'q-on': state.qActive.value }"
        >
          <template v-if="state.filterActive.value">
            {{ filteredBacklog.length }}/{{ state.backlogItems.value.length }}
          </template>
          <template v-else>
            {{ state.backlogItems.value.length }}
          </template>
        </span>
        <button
          v-if="state.editable.value"
          ref="syncBtnEl"
          class="bl-sync"
          :class="{ pending: pending.length > 0, empty: !imported, spin: importing }"
          type="button"
          aria-haspopup="dialog"
          :aria-expanded="syncOpen"
          aria-controls="syncPop"
          :data-tip="
            imported
              ? `从 Jira 拉取||已拉取 ${(team?.importedQuarters || []).join(' / ')}${
                  pending.length ? ` · 待拉取 ${pending.join(' / ')}` : ''
                }`
              : '从 Jira 拉取||按团队 JQL + 勾选的 quarter 导入到 Backlog'
          "
          @click="syncOpen ? closeSyncPop() : openSyncPop()"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M11.6 5.2A4.9 4.9 0 003 4.4M2.4 8.8A4.9 4.9 0 0011 9.6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
            <path
              d="M3 1.9v2.6h2.6M11 12.1V9.5H8.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ imported ? '拉取' : '从 Jira 拉取' }}</span>
          <span class="bl-sync-dot" />
        </button>
        <button
          v-if="state.editable.value"
          class="bl-add"
          data-tip="手动或使用 AI 批量新建 Backlog 条目（不需要 Jira）"
          @click="openAdd"
        >
          <svg width="11" height="11" viewBox="0 0 14 14">
            <path
              d="M7 2.5v9M2.5 7h9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
          新建
        </button>
      </div>
    </div>
    <div ref="bodyEl" class="bl-body">
      <template v-if="renderOps.length">
        <template v-for="op in renderOps" :key="op.id">
          <div v-if="op.kind === 'qlabel'" class="bl-group-label">{{
            op.label === QUARTER_NONE ? '未设置 Quarter' : op.label
          }}<span v-if="op.qOver" class="q-ov">{{ op.qOver }} 超出</span><span v-if="op.uc" class="q-uc">{{ op.uc }} 项 Committed: No</span></div>
          <section
            v-else-if="op.kind === 'inithead'"
            class="bl-init"
            :class="{ collapsed: state.initFold.value.bl.has(op.initKey) }"
            :data-init="op.initKey"
          >
            <div
              class="bl-init-head"
              role="button"
              tabindex="0"
              :aria-expanded="!state.initFold.value.bl.has(op.initKey)"
              @click="toggleBlInit(op.initKey)"
              @keydown.enter.prevent="toggleBlInit(op.initKey)"
              @keydown.space.prevent="toggleBlInit(op.initKey)"
            >
              <svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 5.5L7 9l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
              <div class="bi-main">
                <div class="bi-line">
                  <template v-if="op.initKey !== INIT_NONE">
                    <span class="bi-key" :data-tip="initKeyTip(op.initKey) || undefined">{{ op.initKey }}</span>
                    <span v-if="state.initInfo(op.initKey).loaded && state.initInfo(op.initKey).title" class="bi-title">{{ state.initInfo(op.initKey).title }}</span>
                    <span v-else class="bi-unk" data-tip="INIT 详情未加载||只从 Epic 的 Parent Link 读到 Key；标题、Quarter、Committed 都未拉取||不显示猜测的标题，也不当作完整 INIT">详情未加载</span>
                  </template>
                  <span v-else class="bi-none" data-tip="未关联 INIT||这些 Epic 没有 Parent Link，单独成组，不会被隐藏">未关联 INIT</span>
                  <span v-if="state.initUc(op.initKey)" class="bi-uc" :data-tip="initUcTip(op.initKey)"><i />Committed: No</span>
                </div>
                <div class="bi-meta">
                  <span>待排期 <b>{{ op.items.length }}</b> 个</span>
                  <span :class="{ q: state.filterActive.value }" :data-tip="initHitCountTip(op.stats)">
                    <template v-if="state.filterActive.value">{{ scopeLabel() }} 命中 <b>{{ op.stats.hit.length }}</b> / 已加载 {{ op.stats.all.length }} Epic</template>
                    <template v-else>已加载 <b>{{ op.stats.all.length }}</b> Epic</template>
                  </span>
                  <span
                    v-if="op.stats.sched.length"
                    class="bi-jump"
                    role="button"
                    tabindex="0"
                    :data-tip="`同一 INIT 的已排期 Epic||${op.stats.sched.length} 个在甘特上（左边是待排期，右边是已排期，不是重复）||单击在甘特中定位该 INIT`"
                    @click.stop="jumpToGanttInit(op.initKey)"
                    @keydown.enter.prevent.stop="jumpToGanttInit(op.initKey)"
                    @keydown.space.prevent.stop="jumpToGanttInit(op.initKey)"
                  >另 {{ op.stats.sched.length }} 个已在甘特 →</span>
                </div>
              </div>
            </div>
          </section>
          <div v-else-if="op.kind === 'initqlabel'" class="bl-init-q">{{
            op.label === QUARTER_NONE ? '未设置 Quarter' : op.label
          }}</div>
          <div v-else-if="op.kind === 'initfoot'" class="scope-foot">
            <div v-if="op.allSched.length">
              命中 Epic 已全部排期：<template v-for="k in op.allSched" :key="k"><span
                class="bi-jump"
                role="button"
                tabindex="0"
                :data-tip="`在甘特中定位 ${state.initShortName(k)}`"
                @click="jumpToGanttInit(k)"
                @keydown.enter.prevent="jumpToGanttInit(k)"
              >{{ state.initShortName(k) }} →</span> </template>
            </div>
            <div v-if="op.zero.length">
              当前筛选下 0 命中、未显示：{{ op.zero.map((k) => state.initShortName(k)).join('、') }}
            </div>
          </div>
          <template v-else>
          <div
            v-for="it in [op.item]"
            class="card"
            :class="{
              pop: state.popKeys.value.includes(it.key),
              draft: isDraftItem(it) && !isDoneStatus(it),
              done: isDoneStatus(it),
            }"
            :data-tip="`${cardTipHead(it)}||${it.title}||${tooltipHintLine(it.description, `拖到右侧时间轴排期${it.targetStart || it.targetEnd ? '（按 Target 日期落位）' : ''}`)}`"
            :data-pai-item="it.key"
            :data-pai-team="state.teamId.value"
            :data-pai-target-start="it.targetStart || ''"
            :data-pai-target-end="it.targetEnd || ''"
            @pointerdown="onCardPointerDown($event, it)"
          >
            <a
              v-if="it.jiraKey"
              class="bar-link"
              :href="browseUrl(it.jiraKey)"
              target="_blank"
              rel="noopener"
              data-tip="在 Jira 打开"
              @pointerdown.stop
              @click.stop
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 3H3.5A1.5 1.5 0 002 4.5v4A1.5 1.5 0 003.5 10h4A1.5 1.5 0 009 8.5V7M7 2h3v3M5.5 6.5L10 2" />
              </svg>
            </a>
            <div class="card-top">
              <span class="type-badge" :class="typeBadge(it.type).cls">
                {{ typeBadge(it.type).label }}
              </span>
              <span class="card-key">{{ itemDisplayKey(it) }}</span>
              <span v-if="isDraftItem(it)" class="card-draft">DRAFT</span>
              <span class="card-est">{{ formatEstimate(it.estimate) }}</span>
            </div>
            <div class="card-title">{{ isDoneStatus(it) ? '✓ ' : '' }}{{ it.title }}</div>
            <span
              v-if="it.parentLink"
              class="card-parent"
              :data-tip="`Parent Link ${it.parentLink}||创建 Jira 时写入该 INIT`"
            >
              Parent {{ it.parentLink }}
            </span>
            <span
              v-if="it.owner"
              class="card-owner"
              :data-tip="`Assignee ${showName(it.owner)}||创建 Jira 时写入；甘特上双击可改`"
            >
              <span class="own-av" :style="{ background: memberColor(it.owner) }">{{
                initials(it.owner)
              }}</span>
              {{ showName(it.owner) }}
            </span>
            <span v-if="it.targetStart || it.targetEnd" class="card-target">
              {{ targetLabel(it) }}
            </span>
            <div v-if="itemMsList(it).length" class="card-ms">
              <template v-for="ms in sortedCardMs(it).slice(0, 2)" :key="ms.key">
                <span
                  class="ms-chip"
                  :class="{
                    hit: state.msSel.value.includes(ms.key),
                    late: cardMsLate(it, ms) > 0,
                  }"
                  :data-tip="cardMsTip(it, ms)"
                >
                  <i />
                  {{ msShort(ms) }}
                  <em>
                    {{ ms.milestoneDate ? fmtMD(ms.milestoneDate) : '日期?' }}
                    <template v-if="cardMsLate(it, ms) > 0">
                      · 晚 {{ cardMsLate(it, ms) }}d
                    </template>
                  </em>
                </span>
              </template>
              <span v-if="itemMsList(it).length > 2" class="ms-chip more">
                +{{ itemMsList(it).length - 2 }}
              </span>
            </div>
            <div v-if="cardQOver(it)" class="card-q">
              <span :data-tip="cardQTip(it)">
                <i />超出 {{ cardQOver(it)!.q }}
                <em>Target End {{ fmtMD(cardQOver(it)!.end) }} · +{{ cardQOver(it)!.days }}d</em>
              </span>
            </div>
            <div v-if="cardUc(it)" class="card-uc">
              <span :data-tip="cardUcTip(it)"><i />Committed: No</span>
            </div>
            <span
              v-if="it.subs.length"
              class="card-subs"
              :style="{ marginLeft: it.targetStart || it.targetEnd ? '' : '0' }"
            >
              ↺ {{ it.subs.length }} 个子任务记录
            </span>
            <button
              v-if="state.editable.value && canDeleteItem(it)"
              class="card-del"
              data-tip="删除该手动条目"
              @pointerdown.stop
              @click.stop="removeItem(it)"
            >
              ×
            </button>
          </div>
          </template>
        </template>
      </template>
      <div
        v-else-if="(state.msActive.value || state.qActive.value) && state.backlogItems.value.length"
        class="bl-empty"
      >
        Backlog 中没有属于<br />
        <b v-if="state.qActive.value">{{ qSelNames() }}</b><template v-if="state.qActive.value && state.msActive.value"> 且 </template><b v-if="state.msActive.value">{{ msSelNames() }}</b><br />的未排期条目<template
          v-if="searchText"
        >（且匹配「{{ searchText }}」）</template><br />
        <template v-if="unpulled.length">
          <span class="empty-why"><b>{{ unpulled.join(' / ') }}</b> 尚未从 Jira 拉取 —— 筛选只作用于已加载的数据</span><br />
          <button v-if="state.editable.value" class="bl-empty-link" type="button" @click="pullUnpulled">
            拉取 {{ unpulled.join(' / ') }}…
          </button><br />
        </template>
        <button class="bl-empty-link" type="button" @click="state.setQSel([]); state.setMsSel([])">
          清除 Quarter / Milestone 过滤
        </button>
      </div>
      <div v-else-if="searchText && state.backlogItems.value.length" class="bl-empty">
        没有匹配「{{ searchText }}」的条目<br />
        <button class="bl-empty-link" type="button" @click="clearSearch">清除搜索</button>
      </div>
      <div v-else class="bl-empty">
        <template v-if="imported">
          Backlog 已清空<br />所有 issue 均已排期 🎉
        </template>
        <template v-else>
          尚未导入数据<br />
          <button
            v-if="state.editable.value"
            class="bl-empty-link"
            type="button"
            @click.stop="openSyncPop"
          >
            从 Jira 拉取
          </button>
          <br />或点右上角<b>「新建」</b>手动添加
        </template>
      </div>
    </div>
  </aside>

  <!-- 从 Jira 拉取浮层：Quarter 勾选 + 团队 JQL（可直接跳编辑）+ 拉取按钮 -->
  <div
    v-if="syncOpen"
    ref="syncPopEl"
    class="sync-pop"
    :class="{ show: syncShown }"
    role="dialog"
    aria-labelledby="spTitle"
  >
    <div class="sp-head">
      <div class="sp-title" id="spTitle">从 Jira 拉取到 Backlog</div>
      <div class="sp-sub">
        <template v-if="hasQuarterField">{{ syncSub }}</template>
        <template v-else>按团队 JQL 导入到 Backlog</template>
      </div>
    </div>
    <div v-if="hasQuarterField" class="sp-sec">
      <div class="sp-lbl">QUARTERS</div>
      <div class="chips">
        <button
          v-for="q in chips"
          :key="q"
          class="chip"
          :class="{
            on: team?.checkedQuarters.includes(q),
            ghost:
              (team?.checkedQuarters.length
                ? qCmp(
                    q,
                    team.checkedQuarters.reduce((a, b) => (qCmp(a, b) > 0 ? a : b)),
                  )
                : q !== CURQ
                  ? 1
                  : -1) > 0 && !team?.checkedQuarters.includes(q),
          }"
          :disabled="!state.editable.value"
          @click="toggleQuarter(q)"
        >
          <span class="box">
            <svg width="9" height="9" viewBox="0 0 10 10">
              <path
                d="M1.5 5.5L4 8l4.5-6"
                fill="none"
                stroke="#fff"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          {{ q }}
          <span v-if="q === CURQ" class="now-tag">当前</span>
          <span v-if="team?.importedQuarters.includes(q)" class="got">已拉取</span>
        </button>
      </div>
    </div>
    <div class="sp-src">
      <span class="sp-lbl">JQL</span>
      <span class="sp-jql">{{ team?.jql }}</span>
      <button class="sp-link" type="button" @click="closeSyncPop(); state.modals.value.jql = true">
        编辑
      </button>
    </div>
    <div class="sp-foot">
      <label class="ow-label">
        <input v-model="overwrite" type="checkbox" :disabled="!state.editable.value" />
        覆盖已有数据
      </label>
      <button
        class="btn btn-primary"
        :class="{ locked: !state.hasExtension.value }"
        :disabled="
          !state.editable.value ||
          importing ||
          !showPullBtn ||
          (hasQuarterField && !pullQs.length)
        "
        :data-tip="!state.hasExtension.value ? extensionLockTip('import') : undefined"
        @click="runPull"
      >
        <span v-if="importing" class="mini-spin" />
        <svg v-else class="ico" width="13" height="13" viewBox="0 0 14 14">
          <path
            d="M7 1v8M3.5 6L7 9.5 10.5 6M2 12.5h10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ importing ? '查询 Jira…' : pullBtnLabel }}
        <span v-if="!importing && hasQuarterField && showPullBtn && pullQs.length">
          {{ pullQs.length }}
        </span>
      </button>
    </div>
  </div>

  <div
    class="modal-back"
    :class="{ show: addOpen }"
    @click.self="!saving && (addOpen = false)"
  >
    <div class="modal add-item-modal" :class="{ 'add-item-ai': addMode === 'ai' }">
      <div class="m-head">
        <div class="m-title">新建 Backlog 条目</div>
        <div class="add-tabs">
          <button
            type="button"
            class="add-tab"
            :class="{ on: addMode === 'manual' }"
            @click="addMode = 'manual'"
          >
            手动创建
          </button>
          <button
            type="button"
            class="add-tab"
            :class="{ on: addMode === 'ai' }"
            @click="addMode = 'ai'"
          >
            使用 AI 批量创建
          </button>
        </div>
        <div class="m-sub">
          <template v-if="addMode === 'manual'">
            手动条目不需要 Jira，排期后会以 DRAFT 状态参与规划；之后可在时间轴上一键创建为 Jira issue。
          </template>
          <template v-else>
            粘贴一段需求，一次生成主任务、子任务和初排甘特，全部保持 Draft。不创建 Jira。
          </template>
        </div>
      </div>
      <div v-if="addMode === 'manual'" class="m-body">
        <label class="f-label">标题 <span class="req">*</span></label>
        <input
          v-model="form.title"
          class="f-input"
          placeholder="例如：Nova 26.4 权限模型重构"
          :disabled="saving"
          @keydown.enter="submitAdd"
          @keydown.esc="addOpen = false"
        />
        <label class="f-label">描述（可选）</label>
        <textarea
          v-model="form.description"
          class="f-input f-desc"
          :maxlength="DESCRIPTION_MAX_CHARS"
          placeholder="背景 / 交付物 / 验收要点。hover 任务条时展示；创建 Jira 时作为 description 的生成依据"
          :disabled="saving"
        />
        <label class="f-label">Parent Link（INIT，可选）</label>
        <input
          v-model="form.parentLink"
          class="f-input"
          placeholder="例如 INIT-1234，或 Jira 链接"
          spellcheck="false"
          :disabled="saving"
        />
        <div class="f-note">
          对应这条条目要挂上的 Initiative。创建 Jira 时作为上下文；直连创建会写入 Parent Link。
        </div>
        <label class="f-label">Assignee（可选）</label>
        <div class="assignee-pick">
          <button
            type="button"
            class="te-owner"
            :data-tip="form.owner ? `Assignee：${showName(form.owner)}（点击更换）` : '选择 Assignee'"
            @pointerdown.prevent
            @click="openAssignee($event.currentTarget as HTMLElement)"
            v-html="memberChipHtml(assigneeMember)"
          />
          <span class="who" :class="{ muted: !form.owner }">{{
            form.owner ? showName(form.owner) : '不指定'
          }}</span>
          <button
            v-if="form.owner"
            type="button"
            class="assignee-clear"
            @click="form.owner = ''"
          >
            清除
          </button>
        </div>
        <div class="f-note">
          团队成员名。创建 Jira 时按映射写入 assignee；排到甘特后双击这条 Epic（不论是否 Draft）也可以改。
        </div>
        <div class="f-grid">
          <div>
            <label class="f-label">类型</label>
            <input
              v-model="form.type"
              class="f-input"
              :placeholder="state.jqlHints.value.itemType || 'Epic'"
              :disabled="saving"
            />
          </div>
          <div>
            <label class="f-label">Quarter</label>
            <select v-model="form.quarter" class="f-input" :disabled="saving">
              <option value="">不指定</option>
              <option v-for="q in quarterOptions" :key="q" :value="q">{{ q }}</option>
            </select>
          </div>
        </div>
        <div class="f-grid">
          <div>
            <label class="f-label">预估（周）</label>
            <input
              v-model="form.estimate"
              class="f-input"
              type="number"
              min="1"
              placeholder="可留空"
              :disabled="saving"
            />
          </div>
          <div>
            <label class="f-label">Target 开始</label>
            <input v-model="form.targetStart" class="f-input" type="date" :disabled="saving" />
          </div>
          <div>
            <label class="f-label">Target 结束</label>
            <input v-model="form.targetEnd" class="f-input" type="date" :disabled="saving" />
          </div>
        </div>
      </div>
      <div v-show="addMode === 'ai'" class="m-body">
        <DraftPlanningModal embedded />
      </div>
      <div v-if="addMode === 'manual'" class="m-foot">
        <button class="btn btn-ghost" :disabled="saving" @click="addOpen = false">取消</button>
        <button
          class="btn btn-primary"
          :disabled="saving || !form.title.trim()"
          @click="submitAdd"
        >
          创建条目
        </button>
      </div>
      <div v-else class="m-foot">
        <button class="btn btn-ghost" @click="addOpen = false">关闭</button>
      </div>
    </div>
  </div>
</template>
