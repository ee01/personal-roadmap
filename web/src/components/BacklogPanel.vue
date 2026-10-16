<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
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
  document.addEventListener('pointerdown', onSyncOutsidePointerDown, true);
  document.addEventListener('keydown', onSyncKeydown, true);
  window.addEventListener('resize', onSyncResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('roadmap-planning-committed', onPlanningCommitted);
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
          :class="{ 'ms-on': state.msActive.value }"
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
          新建条目
        </button>
      </div>
    </div>
    <div ref="bodyEl" class="bl-body">
      <template v-if="filteredBacklog.length">
        <template v-for="[q, items] in groups" :key="q">
          <div class="bl-group-label">{{ q }}</div>
          <div
            v-for="it in items"
            :key="it.key"
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
      <div
        v-else-if="state.msActive.value && state.backlogItems.value.length"
        class="bl-empty"
      >
        Backlog 中没有属于<br /><b>{{ msSelNames() }}</b><br />的未排期条目<template
          v-if="searchText"
        >（且匹配「{{ searchText }}」）</template><br />
        <button class="bl-empty-link" type="button" @click="state.setMsSel([])">
          清除 milestone 过滤
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
          <br />或点右上角<b>「新建条目」</b>手动添加
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
