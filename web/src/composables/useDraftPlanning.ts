import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoadmapState } from './useRoadmapState';
import { CURQ } from './useGeometry';

export type PlanningPhase =
  | 'idle'
  | 'queued'
  | 'generating'
  | 'validating'
  | 'ready'
  | 'needs_input'
  | 'committing'
  | 'committed'
  | 'failed'
  | 'cancelled';

export interface PlanningIssueView {
  code: string;
  severity: string;
  message: string;
  ref?: string;
  decisionId?: string;
  options?: Array<{ id: string; label: string }>;
}

export interface PlanningReceiptView {
  batchId: string;
  requestId: string;
  planId: string;
  createdParents: string[];
  attachedParents: string[];
  createdChildren: string[];
  warnings: PlanningIssueView[];
  assumptions: Array<{ ref: string; field: string; reason: string }>;
  roadmapUrl?: string;
}

const BUSY: PlanningPhase[] = [
  'queued',
  'generating',
  'validating',
  'committing',
];

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function todayIso(timeZone = 'Asia/Shanghai'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function phaseLabel(phase: PlanningPhase): string {
  switch (phase) {
    case 'queued':
      return '排队中';
    case 'generating':
      return '正在拆解需求';
    case 'validating':
      return '正在校验与排期';
    case 'committing':
      return '正在写入 Draft';
    case 'ready':
      return '预览已就绪';
    case 'needs_input':
      return '需要你做选择';
    case 'committed':
      return '已创建 Draft';
    case 'failed':
      return '未创建';
    case 'cancelled':
      return '已取消';
    default:
      return '';
  }
}

export function useDraftPlanning() {
  const state = useRoadmapState();
  const text = ref('');
  const advancedOpen = ref(false);
  const planningStart = ref('');
  const quarter = ref(state.focusQuarter.value || CURQ);
  const parentKeys = ref('');
  const autoCommit = ref(false);
  const phase = ref<PlanningPhase>('idle');
  const errorText = ref('');
  const issues = ref<PlanningIssueView[]>([]);
  const decisions = ref<Record<string, string>>({});
  const capabilities = ref<Awaited<
    ReturnType<typeof state.api.fetchPlanningCapabilities>
  > | null>(null);
  const jobId = ref('');
  const requestId = ref('');
  const planId = ref('');
  const revision = ref<number | null>(null);
  const planHash = ref('');
  const preview = ref<{
    documentTitle?: string;
    parents: Array<{
      ref: string;
      action: string;
      title: string;
      children: Array<{ title: string; owner: string | null; ownerCandidates: string[] }>;
    }>;
  } | null>(null);
  const receipt = ref<PlanningReceiptView | null>(null);
  const undoing = ref(false);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const busy = computed(() => BUSY.includes(phase.value));
  const charCount = computed(() => text.value.length);
  const maxChars = computed(
    () => capabilities.value?.limits?.maxInputChars || 30_000,
  );
  const overLimit = computed(() => charCount.value > maxChars.value);
  const llmReady = computed(() => Boolean(capabilities.value?.features.serverLlm));
  const disclosure = computed(() => {
    const caps = capabilities.value;
    if (!caps?.features.serverLlm) {
      return '服务端 AI 未配置：无法在网页生成，可改用手动创建，或由 Agent 提交结构化计划。';
    }
    const provider = caps.providerDisplayName || '服务端模型';
    const endpoint = caps.endpointDisplayName ? ` · ${caps.endpointDisplayName}` : '';
    return `会将输入及必要的团队规划信息交给 ${provider}${endpoint}；只创建 Roadmap 草稿，不会创建 Jira。`;
  });

  async function loadCapabilities() {
    if (!state.teamId.value || !state.editable.value) return;
    try {
      capabilities.value = await state.api.fetchPlanningCapabilities(state.teamId.value);
    } catch (err: unknown) {
      const e = err as { body?: { error?: string } };
      errorText.value = e.body?.error || '无法读取规划能力';
    }
  }

  function resetResult() {
    phase.value = 'idle';
    errorText.value = '';
    issues.value = [];
    decisions.value = {};
    jobId.value = '';
    requestId.value = '';
    planId.value = '';
    revision.value = null;
    planHash.value = '';
    preview.value = null;
    receipt.value = null;
    stopPoll();
  }

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function applyJob(job: Record<string, unknown>) {
    const next = String(job.status || phase.value) as PlanningPhase;
    phase.value = next;
    jobId.value = String(job.jobId || jobId.value);
    requestId.value = String(job.requestId || requestId.value);
    if (job.planId) planId.value = String(job.planId);
    if (job.revision != null) revision.value = Number(job.revision);
    if (job.planHash) planHash.value = String(job.planHash);
    if (Array.isArray(job.issues)) issues.value = job.issues as PlanningIssueView[];
    if (job.errorCode && (next === 'failed' || next === 'cancelled')) {
      errorText.value = String(job.errorCode);
    }
    const normalized = job.normalized as
      | {
          documentTitle?: string;
          parents?: Array<{
            ref: string;
            action: string;
            title: string;
            children: Array<{
              title: string;
              owner: string | null;
              ownerCandidates: string[];
            }>;
          }>;
        }
      | undefined;
    if (normalized?.parents) {
      preview.value = {
        documentTitle: normalized.documentTitle,
        parents: normalized.parents,
      };
    }
    if (job.receipt && typeof job.receipt === 'object') {
      applyReceipt(job.receipt as PlanningReceiptView);
    }
  }

  function applyReceipt(next: PlanningReceiptView) {
    receipt.value = next;
    phase.value = 'committed';
    state.applyPlanningReceipt(next);
    const parents = next.createdParents.length + next.attachedParents.length;
    state.toast(
      `<span class="ok">✓</span> 已创建 <b>${parents}</b> 个主任务、<b>${next.createdChildren.length}</b> 个子任务 Draft`,
    );
  }

  async function pollJob() {
    if (!state.teamId.value || !jobId.value) return;
    try {
      const job = await state.api.fetchPlanningJob(state.teamId.value, jobId.value);
      applyJob(job);
      if (BUSY.includes(String(job.status || '') as PlanningPhase)) {
        pollTimer = setTimeout(() => {
          void pollJob();
        }, 800);
      }
    } catch (err: unknown) {
      const e = err as { body?: { error?: string } };
      phase.value = 'failed';
      errorText.value = e.body?.error || '查询任务失败';
    }
  }

  async function generate() {
    if (!state.teamId.value || busy.value) return;
    const pasted = text.value.trim();
    if (!pasted) {
      errorText.value = '请先粘贴需求';
      return;
    }
    if (overLimit.value) {
      errorText.value = '输入超出上限，请拆分后再试';
      return;
    }
    if (!llmReady.value) {
      errorText.value = '服务端 AI 未配置';
      return;
    }
    resetResult();
    phase.value = 'queued';
    const id = newRequestId();
    requestId.value = id;
    try {
      const created = await state.api.submitPlanningJob(state.teamId.value, {
        requestId: id,
        text: pasted,
        referenceDate: todayIso(),
        planningStart: planningStart.value || null,
        timezone: 'Asia/Shanghai',
        quarter: quarter.value || null,
        parentSelection: parentKeys.value
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean),
        configurationVersion: capabilities.value?.configurationVersion || null,
        autoCommit: autoCommit.value,
      });
      jobId.value = created.jobId;
      phase.value = (created.status as PlanningPhase) || 'queued';
      void pollJob();
    } catch (err: unknown) {
      const e = err as { body?: { error?: string; issues?: PlanningIssueView[] } };
      phase.value = 'failed';
      errorText.value = e.body?.error || '生成失败，未创建任何条目';
      if (Array.isArray(e.body?.issues)) issues.value = e.body.issues;
    }
  }

  async function cancel() {
    if (!state.teamId.value || !jobId.value) return;
    try {
      const result = await state.api.cancelPlanningJob(state.teamId.value, jobId.value);
      if (result.receipt) {
        applyReceipt(result.receipt as PlanningReceiptView);
        return;
      }
      phase.value = String(result.status || 'cancelled') as PlanningPhase;
      if (phase.value !== 'committed') errorText.value = '已取消，未创建任何条目';
    } catch (err: unknown) {
      const e = err as { body?: { error?: string } };
      errorText.value = e.body?.error || '取消失败';
    }
  }

  async function commitPreview() {
    if (!state.teamId.value || !planId.value || revision.value == null || !planHash.value) {
      return;
    }
    phase.value = 'committing';
    try {
      const result = await state.api.commitPlanningPlan(state.teamId.value, planId.value, {
        requestId: newRequestId(),
        revision: revision.value,
        planHash: planHash.value,
        decisions: decisions.value,
        quarter: quarter.value || null,
      });
      applyReceipt(result.receipt as PlanningReceiptView);
    } catch (err: unknown) {
      const e = err as { body?: { error?: string; issues?: PlanningIssueView[] } };
      if (e.body?.error === 'needs_input') {
        phase.value = 'needs_input';
        if (Array.isArray(e.body.issues)) issues.value = e.body.issues;
        return;
      }
      phase.value = 'failed';
      errorText.value = e.body?.error || '提交失败，未创建任何条目';
    }
  }

  async function undo() {
    if (!state.teamId.value || !receipt.value?.batchId || undoing.value) return;
    undoing.value = true;
    try {
      await state.api.undoPlanningBatch(state.teamId.value, receipt.value.batchId);
      receipt.value = null;
      phase.value = 'idle';
      if (state.teamId.value) {
        state.commitSnapshot(await state.api.fetchTeam(state.teamId.value));
      }
      state.toast('已撤销本批 Draft');
    } catch (err: unknown) {
      const e = err as { body?: { error?: string } };
      errorText.value =
        e.body?.error === 'undo_conflict'
          ? '无法整批撤销：有条目已写成 Jira，或提交后被改过'
          : e.body?.error || '无法撤销';
    } finally {
      undoing.value = false;
    }
  }

  watch(
    () => state.teamId.value,
    () => {
      resetResult();
      void loadCapabilities();
    },
    { immediate: true },
  );

  onBeforeUnmount(stopPoll);

  return {
    text,
    advancedOpen,
    planningStart,
    quarter,
    parentKeys,
    autoCommit,
    phase,
    busy,
    errorText,
    issues,
    decisions,
    capabilities,
    preview,
    receipt,
    undoing,
    charCount,
    maxChars,
    overLimit,
    llmReady,
    disclosure,
    phaseLabel,
    loadCapabilities,
    resetResult,
    generate,
    cancel,
    commitPreview,
    undo,
  };
}
