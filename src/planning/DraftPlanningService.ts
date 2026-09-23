import { getDb } from '../storage/Database.js';
import {
  config,
  configurationVersion,
  endpointDisplayName,
  llmConfigured,
  providerDisplayName,
} from '../config.js';
import type { ActorContext, ItemRow, MemberRow } from '../types.js';
import {
  PLANNING_CLIENT_MIN_VERSION,
  PLANNING_CONTRACT_VERSION,
  PLANNING_LIMITS,
  PLANNING_PROMPT_VERSION,
  type BatchReceipt,
  type DraftPlanV1,
  type ParentSelection,
  type PlanningCapabilities,
  type PlanningSource,
} from './contracts.js';
import { defaultPlanningStart, todayInTimeZone } from './dates.js';
import { requestHash, sha256Hex, utf8Bytes } from './hash.js';
import { validateDraftPlan } from './DraftPlanValidator.js';
import { normalizeDraftPlan } from './DraftScheduleNormalizer.js';
import { commitNormalizedPlan, undoBatch } from './DraftBatchService.js';
import { generateDraftPlan } from '../llm/RoadmapLlmClient.js';
import { applyIntent, getTeamSnapshot } from '../core/TeamService.js';
import { emitTeamEvent } from './eventBuffer.js';
import {
  claimNextJob,
  findRequestById,
  getBatch,
  getJob,
  getPlanRevision,
  getRequest,
  insertJob,
  insertPlanRevision,
  markHandoff,
  newId,
  parseNormalized,
  parseReceipt,
  putRequest,
  updateJob,
} from './PlanningStore.js';

export function planningCapabilities(): PlanningCapabilities {
  const configured = config.ai.enabled && llmConfigured();
  return {
    contractVersion: PLANNING_CONTRACT_VERSION,
    schemaVersion: '1',
    compatibleContractRange: [PLANNING_CONTRACT_VERSION],
    limits: PLANNING_LIMITS,
    features: {
      serverLlm: configured,
      autoCommit: configured,
      undo: true,
      agentAccess: config.ai.agentAccess,
    },
    providerDisplayName: configured ? providerDisplayName() : null,
    endpointDisplayName: configured ? endpointDisplayName() : null,
    configurationVersion: configured ? configurationVersion() : null,
    autoCommitEligible: configured,
    planningClientMinVersion: PLANNING_CLIENT_MIN_VERSION,
  };
}

export type PlanningItemView = 'gantt' | 'backlog';
export type PlanningListView = PlanningItemView | 'all';

export function parsePlanningView(raw: unknown): PlanningListView {
  const value = String(raw || 'all').trim().toLowerCase();
  if (value === 'gantt' || value === 'scheduled') return 'gantt';
  if (value === 'backlog' || value === 'unscheduled') return 'backlog';
  return 'all';
}

function isManualDraft(item: ItemRow): boolean {
  return item.source === 'manual' && !item.jira_key;
}

function toPlanningContextItem(item: ItemRow) {
  const view: PlanningItemView = item.scheduled ? 'gantt' : 'backlog';
  return {
    key: item.key,
    title: item.title,
    type: item.type,
    view,
    scheduled: Boolean(item.scheduled),
    start: item.start_date,
    days: item.days,
    version: item.version,
    jiraKey: item.jira_key,
    description: item.description,
    canDelete: isManualDraft(item),
    canUnschedule: Boolean(item.scheduled),
  };
}

function loadTeamItems(teamId: string, itemKeys?: string[]): ItemRow[] {
  const db = getDb();
  const items = db
    .prepare(`SELECT * FROM items WHERE team_id = ? ORDER BY created_at DESC`)
    .all(teamId) as ItemRow[];
  const wanted = itemKeys?.length ? new Set(itemKeys) : null;
  return items.filter((item) => !wanted || wanted.has(item.key));
}

export function planningContext(
  teamId: string,
  itemKeys?: string[],
  view: PlanningListView = 'all',
) {
  const db = getDb();
  const members = db
    .prepare(`SELECT * FROM members WHERE team_id = ? ORDER BY name`)
    .all(teamId) as MemberRow[];
  const items = loadTeamItems(teamId, itemKeys)
    .map(toPlanningContextItem)
    .filter((item) => view === 'all' || item.view === view);
  return {
    teamId,
    view,
    items,
    members: members.map((member) => ({ id: member.id, name: member.name })),
    contractVersion: PLANNING_CONTRACT_VERSION,
    schemaVersion: '1',
  };
}

export function listPlanningItems(
  teamId: string,
  itemKeys?: string[],
  view: PlanningListView = 'all',
) {
  const all = loadTeamItems(teamId, itemKeys).map(toPlanningContextItem);
  const gantt = all.filter((item) => item.view === 'gantt');
  const backlog = all.filter((item) => item.view === 'backlog');
  return {
    teamId,
    view,
    gantt: view === 'backlog' ? [] : gantt,
    backlog: view === 'gantt' ? [] : backlog,
    counts: { gantt: gantt.length, backlog: backlog.length },
  };
}

export function deletePlanningItem(
  teamId: string,
  actor: ActorContext,
  itemKey: string,
): { status: number; body: Record<string, unknown> } {
  const key = String(itemKey || '').trim();
  if (!key) return { status: 400, body: { error: 'item_key_required' } };
  const result = applyIntent(teamId, { op: 'delete_item', itemKey: key }, actor);
  if (!result.ok) {
    const status =
      result.error === 'item_not_found' ? 404 : result.error === 'item_has_jira' ? 409 : 400;
    return {
      status,
      body: {
        error: result.error,
        itemKey: key,
        message:
          result.error === 'item_has_jira'
            ? '已有 Jira key，不能从 Roadmap 永久删除。要从甘特拿掉请用 roadmap_unschedule_item 退回 Backlog。'
            : result.error,
      },
    };
  }
  return { status: 200, body: { ok: true, deletedKey: key, permanent: true } };
}

export function unschedulePlanningItem(
  teamId: string,
  actor: ActorContext,
  itemKey: string,
  baseVersion?: unknown,
): { status: number; body: Record<string, unknown> } {
  const key = String(itemKey || '').trim();
  if (!key) return { status: 400, body: { error: 'item_key_required' } };
  const db = getDb();
  const item = db
    .prepare(`SELECT * FROM items WHERE team_id = ? AND key = ?`)
    .get(teamId, key) as ItemRow | undefined;
  if (!item) return { status: 404, body: { error: 'item_not_found', itemKey: key } };
  if (!item.scheduled) {
    return { status: 200, body: { ok: true, itemKey: key, view: 'backlog', noop: true } };
  }
  const version =
    baseVersion != null && Number.isFinite(Number(baseVersion))
      ? Number(baseVersion)
      : item.version;
  const result = applyIntent(
    teamId,
    { op: 'unschedule', itemKey: key, baseVersion: version },
    actor,
  );
  if (!result.ok) {
    const status = result.error === 'version_conflict' ? 409 : 400;
    return {
      status,
      body: { error: result.error, itemKey: key, current: result.current },
    };
  }
  return { status: 200, body: { ok: true, itemKey: key, view: 'backlog' } };
}

export function submitStructuredPlan(input: {
  teamId: string;
  requestId: string;
  sources: PlanningSource[];
  plan: unknown;
  referenceDate: string;
  planningStart: string | null;
  timezone: string;
  quarter: string | null;
  parentSelection: ParentSelection;
  actor: ActorContext;
  autoCommit?: boolean;
  decisions?: Record<string, string>;
}): { status: number; body: Record<string, unknown> } {
  const op = 'draft-plans';
  const hash = requestHash({
    sources: input.sources,
    plan: input.plan,
    referenceDate: input.referenceDate,
    planningStart: input.planningStart,
    timezone: input.timezone,
    quarter: input.quarter,
    parentSelection: input.parentSelection,
  });
  const existing = getRequest(input.teamId, op, input.requestId);
  if (existing) {
    if (existing.request_hash !== hash) {
      return { status: 409, body: { error: 'request_id_conflict' } };
    }
    return { status: 200, body: JSON.parse(existing.result_json) };
  }

  const validated = validateDraftPlan({ plan: input.plan, sources: input.sources });
  if (!validated.ok || !validated.plan) {
    return { status: 422, body: { error: 'invalid_plan', issues: validated.issues } };
  }
  const planId = newId();
  const now = Date.now();
  const db = getDb();
  const items = db.prepare(`SELECT * FROM items WHERE team_id = ?`).all(input.teamId) as ItemRow[];
  const members = db.prepare(`SELECT * FROM members WHERE team_id = ?`).all(input.teamId) as MemberRow[];
  const planningStart =
    input.planningStart ||
    defaultPlanningStart({
      quarter: input.quarter,
      referenceDate: input.referenceDate,
    });
  const normalized = normalizeDraftPlan(
    validated.plan,
    {
      teamId: input.teamId,
      quarter: input.quarter,
      referenceDate: input.referenceDate,
      planningStart,
      timezone: input.timezone,
      items,
      members,
      parentSelection: input.parentSelection,
      planId,
      revision: 1,
    },
    validated.issues,
  );
  const hasErrors = normalized.issues.some((issue) => issue.severity === 'error');
  const needsInput = normalized.issues.some((issue) => issue.severity === 'decision');
  insertPlanRevision({
    id: planId,
    revision: 1,
    team_id: input.teamId,
    plan_hash: normalized.hash,
    status: hasErrors ? 'failed' : needsInput ? 'needs_input' : 'ready',
    source_json: JSON.stringify(input.sources),
    source_hash: sha256Hex(input.sources.map((source) => source.text).join('\n')),
    plan_json: JSON.stringify(validated.plan),
    normalized_json: JSON.stringify(normalized),
    issues_json: JSON.stringify(normalized.issues),
    context_fingerprint: normalized.contextFingerprint,
    committed_batch_id: null,
    created_at: now,
    expires_at: now + PLANNING_LIMITS.planTtlMs,
  });
  const payload: Record<string, unknown> = {
    planId,
    revision: 1,
    hash: normalized.hash,
    status: hasErrors ? 'failed' : needsInput ? 'needs_input' : 'ready',
    issues: normalized.issues,
    warnings: normalized.warnings,
    normalized,
  };
  if (hasErrors) {
    putRequest({
      team_id: input.teamId,
      operation: op,
      request_id: input.requestId,
      request_hash: hash,
      result_kind: 'plan',
      result_id: planId,
      result_json: JSON.stringify(payload),
      created_at: now,
    });
    return { status: 422, body: payload };
  }
  if (input.autoCommit && !needsInput) {
    const committed = commitNormalizedPlan({
      teamId: input.teamId,
      requestId: input.requestId,
      planRow: getPlanRevision(input.teamId, planId, 1)!,
      normalized,
      actor: input.actor,
      decisions: input.decisions,
      publicBaseUrl: config.publicBaseUrl,
      quarter: input.quarter,
    });
    if (!committed.ok) {
      return {
        status: committed.status || 422,
        body: {
          error: committed.error,
          issues: committed.issues,
          planId,
          revision: 1,
          hash: normalized.hash,
        },
      };
    }
    payload.status = 'committed';
    payload.receipt = committed.receipt;
    emitTeamEvent('snapshot', getTeamSnapshot(input.teamId), input.teamId);
  }
  putRequest({
    team_id: input.teamId,
    operation: op,
    request_id: input.requestId,
    request_hash: hash,
    result_kind: payload.receipt ? 'receipt' : 'plan',
    result_id: planId,
    result_json: JSON.stringify(payload),
    created_at: now,
  });
  return { status: payload.receipt ? 201 : 200, body: payload };
}

export function commitPlan(input: {
  teamId: string;
  planId: string;
  requestId: string;
  revision: number;
  planHash: string;
  actor: ActorContext;
  decisions?: Record<string, string>;
  quarter?: string | null;
}): { status: number; body: Record<string, unknown> } {
  const existing = getRequest(input.teamId, 'commit', input.requestId);
  if (existing) return { status: 200, body: JSON.parse(existing.result_json) };
  const row = getPlanRevision(input.teamId, input.planId, input.revision);
  if (!row) return { status: 404, body: { error: 'plan_not_found' } };
  const normalized = parseNormalized(row);
  if (normalized.hash !== input.planHash) {
    return { status: 409, body: { error: 'plan_hash_mismatch' } };
  }
  const result = commitNormalizedPlan({
    teamId: input.teamId,
    requestId: input.requestId,
    planRow: row,
    normalized,
    actor: input.actor,
    decisions: input.decisions,
    publicBaseUrl: config.publicBaseUrl,
    quarter: input.quarter || null,
  });
  if (!result.ok) {
    return {
      status: result.status || 422,
      body: { error: result.error, issues: result.issues },
    };
  }
  putRequest({
    team_id: input.teamId,
    operation: 'commit',
    request_id: input.requestId,
    request_hash: requestHash({
      planId: input.planId,
      revision: input.revision,
      planHash: input.planHash,
    }),
    result_kind: 'receipt',
    result_id: result.receipt.batchId,
    result_json: JSON.stringify({ receipt: result.receipt }),
    created_at: Date.now(),
  });
  emitTeamEvent('snapshot', getTeamSnapshot(input.teamId), input.teamId);
  return { status: 201, body: { receipt: result.receipt } };
}

export function createPlanningJob(input: {
  teamId: string;
  requestId: string;
  text: string;
  referenceDate: string;
  planningStart: string | null;
  timezone: string;
  quarter: string | null;
  parentSelection: ParentSelection;
  configurationVersion: string | null;
  autoCommit: boolean;
  actor: ActorContext;
}): { status: number; body: Record<string, unknown> } {
  if (!config.ai.enabled || !llmConfigured()) {
    return { status: 503, body: { error: 'provider_unconfigured' } };
  }
  const current = configurationVersion();
  if (input.configurationVersion && input.configurationVersion !== current) {
    return {
      status: 409,
      body: { error: 'configuration_changed', configurationVersion: current },
    };
  }
  if (
    input.text.length > PLANNING_LIMITS.maxInputChars ||
    utf8Bytes(input.text) > PLANNING_LIMITS.maxInputBytes
  ) {
    return { status: 413, body: { error: 'input_too_large' } };
  }
  const hash = requestHash({
    text: input.text,
    referenceDate: input.referenceDate,
    planningStart: input.planningStart,
    timezone: input.timezone,
    quarter: input.quarter,
    parentSelection: input.parentSelection,
    configurationVersion: current,
    autoCommit: input.autoCommit,
  });
  const existing = getRequest(input.teamId, 'jobs', input.requestId);
  if (existing) {
    if (existing.request_hash !== hash) {
      return { status: 409, body: { error: 'request_id_conflict' } };
    }
    return { status: 200, body: JSON.parse(existing.result_json) };
  }
  const now = Date.now();
  const jobId = newId();
  insertJob({
    id: jobId,
    team_id: input.teamId,
    request_id: input.requestId,
    status: 'queued',
    auto_commit: input.autoCommit ? 1 : 0,
    configuration_version: current,
    prompt_version: PLANNING_PROMPT_VERSION,
    schema_version: '1',
    provider: config.ai.provider,
    model: config.ai.provider === 'claude' ? config.ai.claude.model : config.ai.openai.model,
    endpoint_display: endpointDisplayName(),
    lease_until: null,
    lease_generation: 0,
    attempt: 0,
    deadline_at: null,
    queued_at: now,
    started_at: null,
    finished_at: null,
    cancel_requested: 0,
    plan_id: null,
    batch_id: null,
    error_code: null,
    error_message: null,
    source_json: JSON.stringify([{ id: 'paste', title: 'paste', text: input.text }]),
    source_hash: sha256Hex(input.text),
    options_json: JSON.stringify({
      referenceDate: input.referenceDate,
      planningStart: input.planningStart,
      timezone: input.timezone,
      quarter: input.quarter,
      parentSelection: input.parentSelection,
      actor: {
        name: input.actor.name,
        clientId: input.actor.clientId,
        source: 'web_ai',
      },
    }),
    usage_json: null,
    issues_json: null,
  });
  const body = { jobId, status: 'queued', requestId: input.requestId };
  putRequest({
    team_id: input.teamId,
    operation: 'jobs',
    request_id: input.requestId,
    request_hash: hash,
    result_kind: 'job',
    result_id: jobId,
    result_json: JSON.stringify(body),
    created_at: now,
  });
  void processJobsOnce();
  return { status: 202, body };
}

export function jobPayload(teamId: string, jobId: string) {
  const job = getJob(teamId, jobId);
  if (!job) return null;
  const plan = job.plan_id ? getPlanRevision(teamId, job.plan_id) : null;
  const batch = job.batch_id ? getBatch(teamId, job.batch_id) : null;
  return {
    jobId: job.id,
    requestId: job.request_id,
    status: job.status,
    planId: job.plan_id,
    batchId: job.batch_id,
    errorCode: job.error_code,
    issues: job.issues_json
      ? JSON.parse(job.issues_json)
      : plan
        ? JSON.parse(plan.issues_json)
        : [],
    configurationVersion: job.configuration_version,
    providerDisplayName: job.provider,
    endpointDisplayName: job.endpoint_display,
    revision: plan?.revision ?? null,
    planHash: plan?.plan_hash ?? null,
    planStatus: plan?.status ?? null,
    plan: plan ? JSON.parse(plan.plan_json) : null,
    normalized: plan ? parseNormalized(plan) : null,
    receipt: batch ? parseReceipt(batch) : null,
  };
}

export function planPayload(teamId: string, planId: string) {
  const plan = getPlanRevision(teamId, planId);
  if (!plan) return null;
  const batch = plan.committed_batch_id ? getBatch(teamId, plan.committed_batch_id) : null;
  return {
    planId: plan.id,
    revision: plan.revision,
    status: plan.status,
    planHash: plan.plan_hash,
    issues: JSON.parse(plan.issues_json),
    plan: JSON.parse(plan.plan_json),
    normalized: parseNormalized(plan),
    receipt: batch ? parseReceipt(batch) : null,
  };
}

export function cancelJob(teamId: string, jobId: string) {
  const job = getJob(teamId, jobId);
  if (!job) return { status: 404, body: { error: 'job_not_found' } };
  if (job.status === 'committed' && job.batch_id) {
    const batch = getBatch(teamId, job.batch_id);
    return {
      status: 200,
      body: { status: 'committed', receipt: batch ? parseReceipt(batch) : null },
    };
  }
  updateJob(job.id, {
    cancel_requested: 1,
    status: job.status === 'queued' ? 'cancelled' : job.status,
    finished_at: Date.now(),
  });
  return { status: 200, body: { status: 'cancelled', jobId } };
}

export function lookupRequest(teamId: string, requestId: string) {
  const row = findRequestById(teamId, requestId);
  if (!row) return { status: 404, body: { error: 'request_not_found' } };
  return { status: 200, body: JSON.parse(row.result_json) };
}

export function getBatchPayload(teamId: string, batchId: string) {
  const batch = getBatch(teamId, batchId);
  if (!batch) return { status: 404, body: { error: 'batch_not_found' } };
  return {
    status: 200,
    body: {
      batch: parseReceipt(batch),
      status: batch.status,
      undoUntil: batch.undo_until,
    },
  };
}

export function undoPlanningBatch(input: {
  teamId: string;
  batchId: string;
  actor: ActorContext;
}) {
  const result = undoBatch(input);
  if (!result.ok) {
    return {
      status: result.status || 409,
      body: { error: result.error, issues: result.issues },
    };
  }
  emitTeamEvent('snapshot', getTeamSnapshot(input.teamId), input.teamId);
  return { status: 200, body: { receipt: result.receipt } };
}

export function declareJiraHandoff(
  teamId: string,
  refs: Array<{ itemKey?: string; subId?: string }>,
) {
  const result = markHandoff(teamId, refs, 'in_progress');
  if (!result.ok) return { status: 409, body: { error: result.error } };
  return { status: 200, body: { ok: true } };
}

export function revisePlan(input: {
  teamId: string;
  planId: string;
  baseRevision: number;
  changes: Record<string, unknown>;
}): { status: number; body: Record<string, unknown> } {
  const current = getPlanRevision(input.teamId, input.planId, input.baseRevision);
  if (!current) return { status: 404, body: { error: 'plan_not_found' } };
  if (current.status === 'committed') return { status: 409, body: { error: 'plan_committed' } };
  const latest = getPlanRevision(input.teamId, input.planId);
  if (!latest || latest.revision !== input.baseRevision) {
    return { status: 409, body: { error: 'revision_conflict', current: latest?.revision } };
  }
  const plan = JSON.parse(current.plan_json) as DraftPlanV1;
  const nextPlan = applyPlanChanges(plan, input.changes);
  const sources = (current.source_json ? JSON.parse(current.source_json) : []) as PlanningSource[];
  const validated = validateDraftPlan({ plan: nextPlan, sources });
  if (!validated.ok || !validated.plan) {
    return { status: 422, body: { error: 'invalid_plan', issues: validated.issues } };
  }
  const db = getDb();
  const items = db.prepare(`SELECT * FROM items WHERE team_id = ?`).all(input.teamId) as ItemRow[];
  const members = db.prepare(`SELECT * FROM members WHERE team_id = ?`).all(input.teamId) as MemberRow[];
  const options = (input.changes.options || {}) as {
    referenceDate?: string;
    planningStart?: string;
    timezone?: string;
    quarter?: string;
    parentSelection?: ParentSelection;
  };
  const normalized = normalizeDraftPlan(
    validated.plan,
    {
      teamId: input.teamId,
      quarter: options.quarter || null,
      referenceDate: options.referenceDate || todayInTimeZone(Date.now(), 'Asia/Shanghai'),
      planningStart: options.planningStart || null,
      timezone: options.timezone || 'Asia/Shanghai',
      items,
      members,
      parentSelection: options.parentSelection || { itemKeys: [] },
      planId: current.id,
      revision: current.revision + 1,
    },
    validated.issues,
  );
  const now = Date.now();
  const hasErrors = normalized.issues.some((issue) => issue.severity === 'error');
  const needsInput = normalized.issues.some((issue) => issue.severity === 'decision');
  insertPlanRevision({
    ...current,
    revision: current.revision + 1,
    plan_hash: normalized.hash,
    status: hasErrors ? 'failed' : needsInput ? 'needs_input' : 'ready',
    plan_json: JSON.stringify(validated.plan),
    normalized_json: JSON.stringify(normalized),
    issues_json: JSON.stringify(normalized.issues),
    context_fingerprint: normalized.contextFingerprint,
    created_at: now,
    expires_at: now + PLANNING_LIMITS.planTtlMs,
    committed_batch_id: null,
  });
  return {
    status: hasErrors ? 422 : 200,
    body: {
      planId: current.id,
      revision: current.revision + 1,
      hash: normalized.hash,
      status: hasErrors ? 'failed' : needsInput ? 'needs_input' : 'ready',
      issues: normalized.issues,
      warnings: normalized.warnings,
      normalized,
    },
  };
}

export async function processJobsOnce(): Promise<void> {
  const now = Date.now();
  const job = claimNextJob(now, 'local');
  if (!job) return;
  if (job.cancel_requested) {
    updateJob(job.id, { status: 'cancelled', finished_at: now });
    return;
  }
  if (job.configuration_version !== configurationVersion()) {
    updateJob(job.id, {
      status: 'failed',
      error_code: 'configuration_changed',
      error_message: 'provider configuration changed',
      finished_at: now,
    });
    return;
  }
  const options = JSON.parse(job.options_json) as {
    referenceDate: string;
    planningStart: string | null;
    timezone: string;
    quarter: string | null;
    parentSelection: ParentSelection;
    actor: ActorContext;
  };
  const sources = (job.source_json ? JSON.parse(job.source_json) : []) as PlanningSource[];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);
  try {
    const ctx = planningContext(job.team_id);
    const generated = await generateDraftPlan({
      sources,
      referenceDate: options.referenceDate,
      planningStart:
        options.planningStart ||
        defaultPlanningStart({
          quarter: options.quarter,
          referenceDate: options.referenceDate,
        }),
      timezone: options.timezone,
      quarter: options.quarter,
      parentHints: ctx.items.map((item) => ({
        key: item.key,
        title: item.title,
        scheduled: item.scheduled,
      })),
      members: ctx.members.map((member) => member.name),
      signal: controller.signal,
    });
    if (generated.truncated || generated.refused) {
      updateJob(job.id, {
        status: 'failed',
        error_code: generated.truncated ? 'provider_truncated' : 'provider_refused',
        error_message: generated.truncated ? 'model output truncated' : 'model refused',
        finished_at: Date.now(),
      });
      return;
    }
    const submitted = submitStructuredPlan({
      teamId: job.team_id,
      requestId: `${job.request_id}:plan`,
      sources,
      plan: generated.plan,
      referenceDate: options.referenceDate,
      planningStart: options.planningStart,
      timezone: options.timezone,
      quarter: options.quarter,
      parentSelection: options.parentSelection,
      actor: { ...options.actor, source: 'web_ai' },
      autoCommit: Boolean(job.auto_commit),
    });
    const body = submitted.body;
    const receipt = body.receipt as BatchReceipt | undefined;
    updateJob(job.id, {
      status: receipt
        ? 'committed'
        : submitted.status >= 400
          ? 'failed'
          : String(body.status || 'ready'),
      plan_id: typeof body.planId === 'string' ? body.planId : null,
      batch_id: receipt?.batchId || null,
      issues_json: JSON.stringify(body.issues || []),
      usage_json: JSON.stringify(generated.usage),
      error_code: submitted.status >= 400 ? String(body.error || 'invalid_plan') : null,
      finished_at: Date.now(),
      source_json: null,
    });
  } catch (error) {
    const err = error as Error & { errorCode?: string };
    updateJob(job.id, {
      status: 'failed',
      error_code: err.errorCode || 'provider_invalid_json',
      error_message: err.message,
      finished_at: Date.now(),
    });
  } finally {
    clearTimeout(timer);
  }
}

function applyPlanChanges(plan: DraftPlanV1, changes: Record<string, unknown>): DraftPlanV1 {
  const next: DraftPlanV1 = JSON.parse(JSON.stringify(plan));
  const selected = Array.isArray(changes.selectedRefs)
    ? new Set((changes.selectedRefs as unknown[]).map(String))
    : null;
  if (selected) {
    next.parents = next.parents
      .filter(
        (parent) => selected.has(parent.ref) || parent.children.some((child) => selected.has(child.ref)),
      )
      .map((parent) => ({
        ...parent,
        children: parent.children.filter(
          (child) => selected.has(child.ref) || selected.has(parent.ref),
        ),
      }));
  }
  const titles = changes.titles as Record<string, string> | undefined;
  const descriptions = changes.descriptions as Record<string, string> | undefined;
  const owners = changes.owners as Record<string, string | null> | undefined;
  for (const parent of next.parents) {
    if (titles?.[parent.ref]) parent.title = titles[parent.ref];
    if (descriptions?.[parent.ref] != null) parent.description = descriptions[parent.ref];
    for (const child of parent.children) {
      if (titles?.[child.ref]) child.title = titles[child.ref];
      if (descriptions?.[child.ref] != null) child.description = descriptions[child.ref];
      if (owners && Object.prototype.hasOwnProperty.call(owners, child.ref)) {
        child.owner = owners[child.ref];
        if (owners[child.ref]) child.ownerCandidates = [owners[child.ref] as string];
      }
    }
  }
  return next;
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

export function startPlanningWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void processJobsOnce();
  }, 750);
}

export function stopPlanningWorker(): void {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

export { todayInTimeZone };
