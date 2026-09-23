<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoadmapState } from '../../composables/useRoadmapState';
import {
  buildCreateJiraPayload,
  buildDraftGroups,
  createItemRowId,
  createSubRowId,
  draftGroupCanRetry,
  isDraftItem,
  itemDisplayKey,
  sliceDraftGroupForRetry,
  subTypeComesFromCreateMeta,
  typeBadge,
  type DraftGroup,
} from '../../composables/useRoadmapContract';
import {
  bridgeAgentCreateJira,
  bridgeCreateJira,
  bridgeListAgentExecutors,
  bridgeOpenOptionsPage,
  type AgentExecutorOption,
} from '../../composables/useExtensionBridge';
import {
  landReleaseName,
  type ReleaseSheetConfig,
} from '../../composables/useReleaseRuler';
import { addD, fmtISO } from '../../composables/useGeometry';
import {
  getAiPromptDraft,
  setAiPromptDraft,
} from '../../composables/useRoadmapApi';
import {
  buildAgentCreatePrompt,
  dispName,
  resolveAssignee,
  teamAssigneeMap,
  type ResolvedAssignee,
} from '../../composables/useAssigneeMap';
import {
  extensionLockTip,
  useExtensionGate,
} from '../../composables/useExtensionGate';
import {
  AGENT_CREATE_CONCURRENCY,
  runWithConcurrency,
} from '../../composables/runWithConcurrency';

type RowStatus =
  | { kind: 'pending' }
  | { kind: 'loading' }
  | { kind: 'ok'; jiraKey: string; aliasKept?: boolean; warnings?: string[] }
  | { kind: 'error'; message: string; jiraKey?: string };

const AI_EXECUTOR_KEY = 'personalroadmap.aiExecutor';

const state = useRoadmapState();
const gate = useExtensionGate();
const running = computed({
  get: () => state.createJiraRunning.value,
  set: (v: boolean) => {
    state.createJiraRunning.value = v;
  },
});
const rowStatus = ref<Record<string, RowStatus>>({});
const promptPeekOpen = ref(false);
const createAttempt = ref(0);

const prompt = ref('');
const projectKey = ref('');
const itemType = ref('');
const subType = ref('');
const fixVersion = ref('');
const sprint = ref('');
const executors = ref<AgentExecutorOption[]>([]);
const selectedExecutor = ref('');
const executorsLoading = ref(false);

const assigneeMap = computed(() => teamAssigneeMap(state.snapshot.value));
const currentUser = computed(() => state.api.actorName.value || '');

function resolveSub(sub: { owner?: string | null; createdBy: string }): ResolvedAssignee {
  return resolveAssignee({
    map: assigneeMap.value,
    sub,
    currentUser: currentUser.value,
  });
}

function openAssigneeMap() {
  state.modals.value.assigneeMap = true;
}

function showName(name: string) {
  return dispName(assigneeMap.value, name);
}

/**
 * Rows are frozen for the duration of a run: resolving a child immediately
 * drops it out of the live draft list, and a row that vanishes takes its
 * "created as NOVA-123" status with it.
 */
const frozenGroups = ref<DraftGroup[] | null>(null);
const groups = computed(
  () => frozenGroups.value ?? buildDraftGroups(state.scheduledItems.value),
);

const assigneeChips = computed(() => {
  const seen = new Map<string, ResolvedAssignee>();
  for (const g of groups.value) {
    for (const sub of g.subs) {
      const r = resolveSub(sub);
      const k = r.name.toLowerCase();
      if (!seen.has(k)) seen.set(k, r);
    }
  }
  return [...seen.values()];
});

const assigneeByDraftId = computed(() => {
  const map: Record<string, string | null> = {};
  for (const g of groups.value) {
    for (const sub of g.subs) {
      map[sub.id] = resolveSub(sub).user;
    }
  }
  return map;
});

const fullAgentPrompt = computed(() => {
  const drafts: Array<{
    item: DraftGroup['item'];
    sub: DraftGroup['subs'][number];
  }> = [];
  for (const g of groups.value) {
    for (const sub of g.subs) drafts.push({ item: g.item, sub });
  }
  return buildAgentCreatePrompt({
    userPrompt: prompt.value,
    projectKey: projectKey.value.trim(),
    itemType: itemType.value.trim(),
    subType: subType.value.trim(),
    fixVersion: fixVersion.value.trim(),
    sprint: sprint.value.trim(),
    map: assigneeMap.value,
    currentUser: currentUser.value,
    members: state.snapshot.value?.members || [],
    items: state.snapshot.value?.items || [],
    drafts,
    suggestedFixVersions: fixVersionByKey.value,
  });
});

const totalRows = computed(() =>
  groups.value.reduce(
    (n, g) => n + (isDraftItem(g.item) ? 1 : 0) + g.subs.length,
    0,
  ),
);
const needsSubType = computed(() => groups.value.some((g) => g.subs.length > 0));
const needsParent = computed(() => groups.value.some((g) => isDraftItem(g.item)));
const agentMode = computed(() => prompt.value.trim().length > 0);

const teamSheet = computed<ReleaseSheetConfig | null>(() => {
  const cfg = state.snapshot.value?.team.releaseSheet as
    | ReleaseSheetConfig
    | null
    | undefined;
  return cfg?.rows?.length ? cfg : null;
});

function endDateOf(row: {
  targetEnd?: string | null;
  start?: string | null;
  days?: number | null;
}): string | null {
  if (row.targetEnd) return row.targetEnd;
  if (row.start && row.days && row.days > 0) {
    return fmtISO(addD(row.start, row.days - 1));
  }
  return null;
}

function suggestedFixVersion(row: {
  targetEnd?: string | null;
  start?: string | null;
  days?: number | null;
}): string | null {
  const end = endDateOf(row);
  if (!end || !teamSheet.value) return null;
  return landReleaseName(end, teamSheet.value);
}

const fixVersionByKey = computed(() => {
  const map: Record<string, string | null> = {};
  for (const g of groups.value) {
    if (isDraftItem(g.item)) {
      map[g.item.key] = suggestedFixVersion(g.item);
    }
    for (const sub of g.subs) {
      map[sub.id] = suggestedFixVersion(sub);
    }
  }
  return map;
});

const uniqueSuggestedReleases = computed(() => {
  const set = new Set<string>();
  for (const value of Object.values(fixVersionByKey.value)) {
    if (value) set.add(value);
  }
  return [...set];
});

const fixVersionNote = computed(() => {
  if (!teamSheet.value) {
    return '配置发布时间表（JQL ✎ 弹窗）后可按 Target End 落点列自动填写';
  }
  if (uniqueSuggestedReleases.value.length === 1) {
    return '已按任务 Target End 在发布时间表上的落点列填入，可修改。Jira 尚无此版本时会留空 fixVersion 并继续创建';
  }
  if (uniqueSuggestedReleases.value.length > 1) {
    return `任务落在不同 release（${uniqueSuggestedReleases.value.join(' / ')}），共享字段留空；优先按各任务落点填写，Jira 无此版本则留空继续。输入固定值可覆盖全部`;
  }
  return '所有任务的 Target End 没有落在任何 release 列';
});

const fixVersionPlaceholder = computed(() => {
  if (agentMode.value && !fixVersion.value.trim()) {
    return '自动 · 由 Agent 决定';
  }
  if (!teamSheet.value) return '如 26.3.220';
  if (uniqueSuggestedReleases.value.length === 1) return uniqueSuggestedReleases.value[0];
  return '留空 · Agent 按各任务落点判断';
});

const agentPlaceholder = '自动 · 由 Agent 决定';

/**
 * `confident` only covers the issue type, so an unparsed project key has to be
 * reported separately. Neither blocks the dialog — the fields above are
 * editable exactly so the user can fill in what the JQL did not say.
 */
const hintWarning = computed(() => {
  const hints = state.jqlHints.value;
  const missing: string[] = [];
  if (!hints.confident) missing.push('issue 类型');
  if (!hints.projectKey) missing.push('project');
  return missing.length ? `未能从 JQL 识别${missing.join(' 与 ')}，请手动填写` : '';
});

/** Task-level parents take a sub-task whose name only Jira knows — see the helper. */
const subTypeAuto = computed(() => subTypeComesFromCreateMeta(itemType.value));

const extensionMissing = computed(() => !state.hasExtension.value);

const blockReason = computed(() => {
  if (extensionMissing.value) return '需要 Personal AI 扩展';
  if (!state.editable.value) return '当前为只读模式';
  if (agentMode.value) {
    if (!executors.value.length) return '请先配置 Agent 执行器';
    if (!selectedExecutor.value) return '请选择 Agent 执行器';
    return '';
  }
  if (!projectKey.value.trim()) return '请填写 Project Key';
  if (needsParent.value && !itemType.value.trim()) return '请填写主任务类型';
  if (needsSubType.value && !subType.value.trim() && !subTypeAuto.value) {
    return '请填写子任务类型';
  }
  return '';
});

function itemRowId(key: string) {
  return createItemRowId(key);
}
function subRowId(id: string) {
  return createSubRowId(id);
}

function hasCreateProgress(): boolean {
  return Object.values(rowStatus.value).some(
    (status) => status.kind === 'ok' || status.kind === 'error',
  );
}

function warningsOf(id: string): string[] {
  const status = statusOf(id);
  return status.kind === 'ok' ? status.warnings || [] : [];
}

function groupCanRetry(group: DraftGroup): boolean {
  return !running.value && draftGroupCanRetry(group, rowStatus.value);
}

const retryableGroupCount = computed(
  () => groups.value.filter((group) => draftGroupCanRetry(group, rowStatus.value)).length,
);

function statusOf(id: string): RowStatus {
  return rowStatus.value[id] || { kind: 'pending' };
}

function kindOf(id: string): RowStatus['kind'] {
  return statusOf(id).kind;
}

function okKey(id: string): string {
  const status = statusOf(id);
  return status.kind === 'ok' ? status.jiraKey : '';
}

function aliasKeptOf(id: string): boolean {
  const status = statusOf(id);
  return status.kind === 'ok' && !!status.aliasKept;
}

function errorOf(id: string): string {
  const status = statusOf(id);
  return status.kind === 'error' ? status.message : '';
}

function loadingLabel(): string {
  if (!agentMode.value) return 'API 创建中';
  const label =
    executors.value.find((e) => e.id === selectedExecutor.value)?.label || 'Agent';
  return `${label} 创建中`;
}

async function refreshExecutors() {
  if (!state.hasExtension.value) {
    executors.value = [];
    return;
  }
  executorsLoading.value = true;
  try {
    const list = await bridgeListAgentExecutors();
    executors.value = list;
    const remembered = localStorage.getItem(AI_EXECUTOR_KEY) || '';
    if (remembered && list.some((e) => e.id === remembered)) {
      selectedExecutor.value = remembered;
    } else if (list.length) {
      selectedExecutor.value = list[0].id;
    } else {
      selectedExecutor.value = '';
    }
  } catch {
    executors.value = [];
    selectedExecutor.value = '';
  } finally {
    executorsLoading.value = false;
  }
}

function selectExecutor(id: string) {
  selectedExecutor.value = id;
  localStorage.setItem(AI_EXECUTOR_KEY, id);
}

async function openOptions() {
  try {
    await bridgeOpenOptionsPage();
  } catch {
    state.toast('无法打开插件 Options，请手动打开扩展设置');
  }
}

watch(
  () => state.modals.value.aiCreate,
  (open) => {
    if (!open) return;
    // Re-opening mid-run, or after a partial result, keeps progress rows so
    // the user can read errors and retry remaining drafts.
    if (!running.value && !hasCreateProgress()) {
      const hints = state.jqlHints.value;
      rowStatus.value = {};
      frozenGroups.value = null;
      createAttempt.value = 0;
      promptPeekOpen.value = false;
      const teamId = state.teamId.value;
      const draft = getAiPromptDraft(teamId);
      const teamPrompt = state.snapshot.value?.team.createJiraPrompt || '';
      prompt.value = draft !== null ? draft : teamPrompt;
      projectKey.value = hints.projectKey || '';
      itemType.value = hints.itemType || '';
      subType.value = hints.subType || '';
      sprint.value = '';
      const uniq = uniqueSuggestedReleases.value;
      fixVersion.value = uniq.length === 1 ? uniq[0] : '';
    }
    void refreshExecutors();
  },
);

// Persist the prompt draft whenever the user types — closing the modal must not lose it.
watch(prompt, (value) => {
  if (!state.modals.value.aiCreate) return;
  const teamId = state.teamId.value;
  if (!teamId) return;
  setAiPromptDraft(teamId, value);
});

watch(uniqueSuggestedReleases, (uniq) => {
  if (!state.modals.value.aiCreate || running.value) return;
  if (!fixVersion.value.trim() && uniq.length === 1) {
    fixVersion.value = uniq[0];
  }
});

function promptForGroup(group: DraftGroup): string {
  return buildAgentCreatePrompt({
    userPrompt: prompt.value,
    projectKey: projectKey.value.trim(),
    itemType: itemType.value.trim(),
    subType: subType.value.trim(),
    fixVersion: fixVersion.value.trim(),
    sprint: sprint.value.trim(),
    map: assigneeMap.value,
    currentUser: currentUser.value,
    members: state.snapshot.value?.members || [],
    items: state.snapshot.value?.items || [],
    drafts: group.subs.map((sub) => ({ item: group.item, sub })),
    suggestedFixVersions: fixVersionByKey.value,
  });
}

function stampFrozenParentKey(itemKey: string, jiraKey: string) {
  const groupsFrozen = frozenGroups.value;
  if (!groupsFrozen || !jiraKey) return;
  frozenGroups.value = groupsFrozen.map((group) =>
    group.item.key === itemKey
      ? { ...group, item: { ...group.item, jiraKey } }
      : group,
  );
}

function rowFromCreateResult(
  result: { jiraKey?: string; error?: string; warnings?: string[] } | undefined,
  fallback: string,
): RowStatus {
  const jiraKey = String(result?.jiraKey || '').trim();
  const warnings = [...(result?.warnings || [])];
  if (result?.error && jiraKey) warnings.push(result.error);
  if (jiraKey) {
    return {
      kind: 'ok',
      jiraKey,
      aliasKept: agentMode.value,
      ...(warnings.length ? { warnings } : {}),
    };
  }
  return { kind: 'error', message: result?.error || fallback };
}

async function start(opts?: { groupKey?: string }) {
  if (extensionMissing.value) {
    gate.openGate('createJira');
    return;
  }
  if (blockReason.value || running.value) return;
  const retrying = hasCreateProgress();
  if (!frozenGroups.value) frozenGroups.value = groups.value;
  if (retrying) createAttempt.value += 1;

  const sourceGroups = opts?.groupKey
    ? groups.value.filter((group) => group.item.key === opts.groupKey)
    : groups.value;
  const jobs = sourceGroups
    .map((group) => sliceDraftGroupForRetry(group, rowStatus.value))
    .filter((group): group is DraftGroup => group != null);
  if (!jobs.length) {
    state.toast('没有可重试的失败项');
    return;
  }

  running.value = true;
  const teamId = state.teamId.value;
  setAiPromptDraft(teamId, prompt.value);
  const trimmedPrompt = prompt.value.trim();
  // Executing with a prompt promotes it to team config so collaborators see it.
  if (
    trimmedPrompt &&
    trimmedPrompt !== (state.snapshot.value?.team.createJiraPrompt || '')
  ) {
    try {
      await state.applySnapshotFromIntent({
        op: 'update_create_jira_prompt',
        prompt: trimmedPrompt,
      });
    } catch {
      /* non-blocking: create can still proceed */
    }
  }
  if (selectedExecutor.value) {
    localStorage.setItem(AI_EXECUTOR_KEY, selectedExecutor.value);
  }
  const token = state.api.getShareToken(teamId) || null;
  const teamName = state.snapshot.value?.team.name || null;
  const override = fixVersion.value.trim() || null;
  let created = 0;
  let failed = 0;

  async function createOneGroup(group: DraftGroup): Promise<void> {
    const parentId = itemRowId(group.item.key);
    const parentIsDraft = isDraftItem(group.item);
    if (parentIsDraft) rowStatus.value[parentId] = { kind: 'loading' };
    for (const sub of group.subs) {
      rowStatus.value[subRowId(sub.id)] = { kind: 'loading' };
    }

    try {
      const baseFields = {
        teamId,
        token,
        projectKey: projectKey.value.trim(),
        issueType: itemType.value.trim(),
        subType: subType.value.trim(),
        fixVersionOverride: override,
        fixVersionByKey: fixVersionByKey.value,
        assigneeByDraftId: assigneeByDraftId.value,
      };
      const createPayload = buildCreateJiraPayload(group, baseFields);
      const result = agentMode.value
        ? await bridgeAgentCreateJira({
            teamId,
            token,
            prompt: promptForGroup(group),
            executor: selectedExecutor.value,
            teamName,
            retryAttempt: createAttempt.value || undefined,
            constraints: {
              projectKey: projectKey.value.trim() || null,
              issueType: itemType.value.trim() || null,
              subType: subType.value.trim() || null,
              fixVersion: override,
              sprint: sprint.value.trim() || null,
            },
            parent: createPayload.parent,
            children: createPayload.children,
          })
        : await bridgeCreateJira(createPayload);

      if (parentIsDraft) {
        const parentStatus = rowFromCreateResult(
          result.parent,
          '未返回 Jira key',
        );
        rowStatus.value[parentId] = parentStatus;
        if (parentStatus.kind === 'ok') {
          created += 1;
          stampFrozenParentKey(group.item.key, parentStatus.jiraKey);
        } else {
          failed += 1;
        }
      }

      const mappings: Array<{ draftId: string; jiraKey: string }> = [];
      for (const sub of group.subs) {
        const row = result.children.find((c) => c.draftId === sub.id);
        const childStatus = rowFromCreateResult(row, '未创建');
        rowStatus.value[subRowId(sub.id)] = childStatus;
        if (childStatus.kind === 'ok') {
          mappings.push({ draftId: sub.id, jiraKey: childStatus.jiraKey });
          created += 1;
        } else {
          failed += 1;
        }
      }
      // Direct path: extension may already have resolved; agent path too.
      // Re-apply is idempotent and keeps the page UI in sync.
      if (mappings.length) {
        await state.applySnapshotFromIntent({ op: 'resolve_draft', mappings }).catch(
          () => undefined,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '创建 Jira 失败';
      if (parentIsDraft) rowStatus.value[parentId] = { kind: 'error', message };
      for (const sub of group.subs) {
        rowStatus.value[subRowId(sub.id)] = { kind: 'error', message };
      }
      failed += group.subs.length + (parentIsDraft ? 1 : 0);
    }
  }

  try {
    if (agentMode.value) {
      await runWithConcurrency(jobs, AGENT_CREATE_CONCURRENCY, createOneGroup);
    } else {
      for (const job of jobs) {
        await createOneGroup(job);
      }
    }

    try {
      if (teamId) state.snapshot.value = await state.api.fetchTeam(teamId);
    } catch {
      /* SSE will catch up */
    }
  } finally {
    running.value = false;
  }
  const execLabel = agentMode.value
    ? executors.value.find((e) => e.id === selectedExecutor.value)?.label
    : null;
  const modalOpen = state.modals.value.aiCreate;
  // Longer toast when the dialog was closed — user may not be looking at the form.
  const toastMs = modalOpen ? 2900 : 5200;
  if (created) {
    state.toast(
      execLabel
        ? `<span class="ok">✓</span> 已由 <b>${execLabel}</b> 创建 <b>${created}</b> 个 Jira issue；草稿名已保留为备注名`
        : `<span class="ok">✓</span> 已创建 <b>${created}</b> 个 Jira issue`,
      toastMs,
    );
  }
  if (failed) {
    state.toast(
      created
        ? `部分失败：成功 ${created} · 失败 ${failed}。可改字段后点组上的重试，已成功的 ticket 不会再创建`
        : `创建失败：${failed} 项未成功。可改字段后重试`,
      toastMs,
    );
  } else if (!retryableGroupCount.value) {
    frozenGroups.value = null;
    createAttempt.value = 0;
    if (modalOpen) state.modals.value.aiCreate = false;
  }
}

function closeModal() {
  state.modals.value.aiCreate = false;
}
</script>

<template>
  <div
    class="modal-back"
    :class="{ show: state.modals.value.aiCreate }"
    @click.self="closeModal"
  >
    <div class="modal" style="width: 620px">
      <div class="m-head">
        <div class="m-title">
          创建 Jira
          <span class="mode-badge" :class="agentMode ? 'agent' : 'api'">
            {{ agentMode ? 'AGENT 执行器' : '直连 API' }}
          </span>
          <span v-if="running" class="m-run-hint">创建中 · 可关闭弹窗</span>
        </div>
        <div class="m-sub">
          Prompt 留空：按下方字段<b>直连 Jira API</b> 创建。填写 Prompt：交给
          <b>Agent 执行器</b>创建（可用技能、自动填当前 Sprint 等动态字段）——已填字段作为约束带给
          Agent，未填字段由 Agent 决定。Jira 里还没有对应 fixVersion 时会<b>留空该字段继续创建</b>，不会因此整行拒绝。失败行可改字段后按 Epic 重试，已成功的 ticket 不会再创建。Prompt 草稿保存在本机；执行创建时同步为团队配置，协作者也能看到。
        </div>
      </div>
      <div class="m-body">
        <div v-if="hintWarning" class="hint-warn">{{ hintWarning }}</div>

        <label class="f-label">创建 Prompt（可选）</label>
        <textarea
          v-model="prompt"
          class="f-input"
          style="min-height: 64px"
          :disabled="running"
          placeholder="例：创建 Task 类型 ticket，Sprint 填当前 sprint，fixVersion 按发布时间表，Team 与父 Epic 保持一致"
        />

        <div class="exec-row" :class="{ show: agentMode }">
          <label class="f-label">Agent 执行器</label>
          <div v-if="executors.length" class="exec-select">
            <button
              v-for="e in executors"
              :key="e.id"
              type="button"
              class="exec-opt"
              :class="{ on: e.id === selectedExecutor }"
              :disabled="running"
              @click="selectExecutor(e.id)"
            >
              <span class="eo-dot" />{{ e.label }}
            </button>
          </div>
          <div class="exec-guide">
            <template v-if="executorsLoading">正在检测执行器…</template>
            <template v-else-if="!executors.length">
              尚未配置任何 Agent 执行器 ——
              <a href="#" @click.prevent="openOptions">去插件 Options 配置</a>，配置后
              <a href="#" @click.prevent="refreshExecutors">重新检测</a>
            </template>
            <template v-else>
              执行器在插件 Options 中管理；已填字段作为约束带给 Agent，未填字段由 Agent 决定。
              <a href="#" @click.prevent="refreshExecutors">重新检测</a>
            </template>
          </div>
        </div>

        <div class="f-grid">
          <div>
            <label class="f-label">Project Key</label>
            <input
              v-model="projectKey"
              class="f-input"
              :placeholder="agentMode ? agentPlaceholder : '如 NOVA'"
              :disabled="running"
            />
          </div>
          <div>
            <label class="f-label">主任务类型</label>
            <input
              v-model="itemType"
              class="f-input"
              :placeholder="agentMode ? agentPlaceholder : '如 Epic'"
              :disabled="running"
            />
          </div>
          <div>
            <label class="f-label">子任务类型</label>
            <input
              v-model="subType"
              class="f-input"
              :placeholder="
                agentMode
                  ? agentPlaceholder
                  : subTypeAuto
                    ? '留空＝由 Jira 决定'
                    : '如 Task'
              "
              :disabled="running"
            />
            <div v-if="!agentMode && subTypeAuto && !subType.trim()" class="f-note">
              留空时扩展会用该项目实际的子任务类型
            </div>
          </div>
        </div>

        <div class="f-grid" style="margin-top: 10px">
          <div>
            <label class="f-label">fixVersion</label>
            <input
              v-model="fixVersion"
              class="f-input"
              :placeholder="fixVersionPlaceholder"
              :disabled="running"
            />
            <div class="f-auto-note">{{ fixVersionNote }}</div>
          </div>
          <div>
            <label class="f-label">Sprint</label>
            <input
              v-model="sprint"
              class="f-input"
              :placeholder="
                agentMode ? agentPlaceholder : '直连 v1 不支持，留空跳过'
              "
              :disabled="running"
            />
            <div class="f-auto-note">
              {{
                agentMode
                  ? '未填时由 Agent 查询当前 Sprint 自动填写'
                  : '直连 API 需要 Sprint ID，v1 不填此字段；要自动填当前 Sprint 请改用 Prompt'
              }}
            </div>
          </div>
        </div>

        <label class="f-label">Assignee</label>
        <div class="asg-bar">
          <span
            v-for="r in assigneeChips"
            :key="r.name"
            class="asg-chip"
            :class="r.user ? 'ok' : 'miss'"
            :data-tip="
              `${showName(r.name)}${r.fallback ? '（按创建人回落）' : ''}||${
                r.user
                  ? 'assignee 将填 ' + r.user
                  : '未映射 Firstname Lastname，无法定位 Jira 用户'
              }||${r.user ? '在「配置映射…」中可修改' : '点击补全映射'}`
            "
            @click="!r.user && openAssigneeMap()"
          >
            {{ showName(r.name) }}<span class="arrow">→</span>{{ r.user || '?' }}
          </span>
          <button type="button" class="asg-cfg" @click="openAssigneeMap">
            配置映射…
          </button>
        </div>
        <div class="asg-note">
          {{
            agentMode
              ? '映射名单随字段约束一并写入 Prompt，由 Agent 在 Jira 检索实名后填写 assignee'
              : 'Owner 按映射转成 firstname.lastname 填入 assignee；未映射的任务将留空 assignee'
          }}
        </div>

        <div v-if="agentMode" style="margin-top: 10px">
          <button
            type="button"
            class="asg-cfg"
            @click="promptPeekOpen = !promptPeekOpen"
          >
            {{ promptPeekOpen ? '收起完整 Prompt' : '查看将发送的完整 Prompt' }}
          </button>
          <div class="f-note" style="margin-top: 6px">
            预览是全部草稿总览；实际发送按 Epic 拆成独立 Agent 请求，最多 2 路并行，每路只含该组 draft。
          </div>
          <pre v-if="promptPeekOpen" class="prompt-peek">{{ fullAgentPrompt }}</pre>
        </div>

        <label class="f-label">
          待创建任务 <span style="color: var(--cur-deep)">（{{ totalRows }}）</span>
        </label>
        <div v-if="!groups.length" class="ai-empty">没有待创建的草稿</div>
        <div v-for="g in groups" :key="g.item.key" class="ai-group">
          <div class="ai-row parent">
            <span class="type-badge" :class="typeBadge(itemType || g.item.type).cls">
              {{ typeBadge(itemType || g.item.type).label }}
            </span>
            <span class="t">{{ g.item.alias || g.item.title }}</span>
            <span
              v-if="g.item.description"
              class="fv-chip desc"
              :data-tip="g.item.description"
            >≡ 描述</span>
            <span
              v-if="teamSheet && isDraftItem(g.item)"
              class="fv-chip"
              :class="{ none: !fixVersionByKey[g.item.key] }"
            >
              {{ fixVersionByKey[g.item.key] || '无匹配 release' }}
            </span>
            <span class="st">
              <template v-if="kindOf(itemRowId(g.item.key)) === 'loading'">
                <span class="mini-spin" /> {{ loadingLabel() }}
              </template>
              <span v-else-if="kindOf(itemRowId(g.item.key)) === 'ok'" class="newkey">
                ✓ {{ okKey(itemRowId(g.item.key)) }}
                <span
                  v-if="aliasKeptOf(itemRowId(g.item.key))"
                  class="alias-kept"
                  data-tip="Agent 已规范化 summary||草稿名保留为备注名，甘特展示不变"
                >草稿名已存为备注</span>
                <span
                  v-for="(warning, idx) in warningsOf(itemRowId(g.item.key))"
                  :key="idx"
                  class="ai-warn"
                  :title="warning"
                >{{ warning }}</span>
              </span>
              <span
                v-else-if="kindOf(itemRowId(g.item.key)) === 'error'"
                class="failkey"
              >
                ✕ {{ errorOf(itemRowId(g.item.key)) }}
              </span>
              <span v-else-if="!isDraftItem(g.item)" class="newkey">
                {{ itemDisplayKey(g.item) }}
              </span>
              <template v-else>待创建</template>
              <button
                v-if="groupCanRetry(g)"
                type="button"
                class="ai-retry"
                title="只重试本组失败项，已成功的 ticket 不会再创建"
                :disabled="running"
                @click.stop="start({ groupKey: g.item.key })"
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    d="M13.2 8A5.2 5.2 0 1 1 11 3.7"
                  />
                  <path fill="currentColor" d="M13.4 2.2v4.1h-4.1z" />
                </svg>
              </button>
            </span>
          </div>
          <div v-for="s in g.subs" :key="s.id" class="ai-row child">
            <span class="child-mark">└</span>
            <span class="t">{{ s.alias || s.title }}</span>
            <span
              v-if="s.description"
              class="fv-chip desc"
              :data-tip="s.description"
            >≡ 描述</span>
            <span
              v-if="teamSheet"
              class="fv-chip"
              :class="{ none: !fixVersionByKey[s.id] }"
            >
              {{ fixVersionByKey[s.id] || '无匹配 release' }}
            </span>
            <span
              class="fv-chip"
              :class="{ none: !resolveSub(s).user }"
              :data-tip="
                `Assignee：${resolveSub(s).full || showName(resolveSub(s).name)}${
                  resolveSub(s).fallback ? '（无 Owner，按创建人回落）' : ''
                }${resolveSub(s).user ? '' : ' · 未映射'}`
              "
            >
              @{{ resolveSub(s).user || '未映射' }}
            </span>
            <span class="st">
              <template v-if="kindOf(subRowId(s.id)) === 'loading'">
                <span class="mini-spin" /> {{ loadingLabel() }}
              </template>
              <span v-else-if="kindOf(subRowId(s.id)) === 'ok'" class="newkey">
                ✓ {{ okKey(subRowId(s.id)) }}
                <span
                  v-if="aliasKeptOf(subRowId(s.id))"
                  class="alias-kept"
                  data-tip="Agent 已规范化 summary||草稿名保留为备注名，甘特展示不变"
                >草稿名已存为备注</span>
                <span
                  v-for="(warning, idx) in warningsOf(subRowId(s.id))"
                  :key="idx"
                  class="ai-warn"
                  :title="warning"
                >{{ warning }}</span>
              </span>
              <span
                v-else-if="kindOf(subRowId(s.id)) === 'error'"
                class="failkey"
              >
                ✕ {{ errorOf(subRowId(s.id)) }}
              </span>
              <template v-else>待创建</template>
            </span>
          </div>
        </div>
      </div>
      <div class="m-foot">
        <button v-if="extensionMissing" class="foot-note eb-link" @click="gate.openGate('createJira')">
          需要 Personal AI 扩展 · 查看安装指引
        </button>
        <span v-else-if="blockReason" class="foot-note">{{ blockReason }}</span>
        <span v-else-if="running" class="foot-note">
          {{
            agentMode
              ? 'Agent 按 Epic 最多 2 路并行；一组失败不影响其它组已成功的回写。关闭后工具栏保持创建中'
              : '关闭后工具栏按钮会保持创建中，完成后 toast 通知'
          }}
        </span>
        <span v-else-if="retryableGroupCount" class="foot-note">
          {{ retryableGroupCount }} 组仍有失败项 · 可改上方字段后重试，已成功的 ticket 不会再创建
        </span>
        <button class="btn btn-ghost" @click="closeModal">
          {{ running ? '关闭（后台继续）' : '取消' }}
        </button>
        <button
          class="btn btn-orange"
          :class="{ locked: extensionMissing }"
          :disabled="running || (!extensionMissing && (!!blockReason || !groups.length))"
          :title="extensionMissing ? undefined : blockReason || undefined"
          :data-tip="extensionMissing ? extensionLockTip('createJira') : undefined"
          @click="start()"
        >
          {{
            running
              ? '创建中…'
              : retryableGroupCount
                ? `重试失败项（${retryableGroupCount}）`
                : '开始创建'
          }}
        </button>
      </div>
    </div>
  </div>
</template>
