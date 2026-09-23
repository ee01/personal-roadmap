import { nanoid } from 'nanoid';
import { getDb } from '../storage/Database.js';
import { PLANNING_LIMITS, type BatchReceipt, type NormalizedDraftPlan } from './contracts.js';

export interface PlanningRequestRow {
  team_id: string;
  operation: string;
  request_id: string;
  request_hash: string;
  result_kind: string;
  result_id: string | null;
  result_json: string;
  created_at: number;
}

export interface PlanningJobRow {
  id: string;
  team_id: string;
  request_id: string;
  status: string;
  auto_commit: number;
  configuration_version: string;
  prompt_version: string;
  schema_version: string;
  provider: string | null;
  model: string | null;
  endpoint_display: string | null;
  lease_until: number | null;
  lease_generation: number;
  attempt: number;
  deadline_at: number | null;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  cancel_requested: number;
  plan_id: string | null;
  batch_id: string | null;
  error_code: string | null;
  error_message: string | null;
  source_json: string | null;
  source_hash: string;
  options_json: string;
  usage_json: string | null;
  issues_json: string | null;
}

export interface DraftPlanRow {
  id: string;
  revision: number;
  team_id: string;
  plan_hash: string;
  status: string;
  source_json: string | null;
  source_hash: string;
  plan_json: string;
  normalized_json: string;
  issues_json: string;
  context_fingerprint: string;
  committed_batch_id: string | null;
  created_at: number;
  expires_at: number;
}

export interface DraftBatchRow {
  id: string;
  team_id: string;
  plan_id: string;
  revision: number;
  request_id: string;
  receipt_json: string;
  status: string;
  undo_until: number;
  committed_at: number;
}

export interface DraftBatchItemRow {
  batch_id: string;
  ref: string;
  kind: string;
  item_key: string | null;
  sub_id: string | null;
  existing: number;
  written_version: number | null;
  handoff_state: string | null;
  snapshot_json: string | null;
}

export function getRequest(
  teamId: string,
  operation: string,
  requestId: string,
): PlanningRequestRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM draft_planning_requests
         WHERE team_id = ? AND operation = ? AND request_id = ?`,
      )
      .get(teamId, operation, requestId) as PlanningRequestRow | undefined) || null
  );
}

export function putRequest(row: PlanningRequestRow): void {
  getDb()
    .prepare(
      `INSERT INTO draft_planning_requests (
        team_id, operation, request_id, request_hash, result_kind, result_id, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, operation, request_id) DO UPDATE SET
        result_kind = excluded.result_kind,
        result_id = excluded.result_id,
        result_json = excluded.result_json`,
    )
    .run(
      row.team_id,
      row.operation,
      row.request_id,
      row.request_hash,
      row.result_kind,
      row.result_id,
      row.result_json,
      row.created_at,
    );
}

export function findRequestById(teamId: string, requestId: string): PlanningRequestRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM draft_planning_requests WHERE team_id = ? AND request_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(teamId, requestId) as PlanningRequestRow | undefined) || null
  );
}

export function insertJob(row: PlanningJobRow): void {
  getDb()
    .prepare(
      `INSERT INTO draft_planning_jobs (
        id, team_id, request_id, status, auto_commit, configuration_version,
        prompt_version, schema_version, provider, model, endpoint_display,
        lease_until, lease_generation, attempt, deadline_at, queued_at, started_at,
        finished_at, cancel_requested, plan_id, batch_id, error_code, error_message,
        source_json, source_hash, options_json, usage_json, issues_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.team_id,
      row.request_id,
      row.status,
      row.auto_commit,
      row.configuration_version,
      row.prompt_version,
      row.schema_version,
      row.provider,
      row.model,
      row.endpoint_display,
      row.lease_until,
      row.lease_generation,
      row.attempt,
      row.deadline_at,
      row.queued_at,
      row.started_at,
      row.finished_at,
      row.cancel_requested,
      row.plan_id,
      row.batch_id,
      row.error_code,
      row.error_message,
      row.source_json,
      row.source_hash,
      row.options_json,
      row.usage_json,
      row.issues_json,
    );
}

export function getJob(teamId: string, jobId: string): PlanningJobRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM draft_planning_jobs WHERE team_id = ? AND id = ?`)
      .get(teamId, jobId) as PlanningJobRow | undefined) || null
  );
}

export function getJobById(jobId: string): PlanningJobRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM draft_planning_jobs WHERE id = ?`)
      .get(jobId) as PlanningJobRow | undefined) || null
  );
}

export function updateJob(id: string, fields: Partial<PlanningJobRow>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE draft_planning_jobs SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`;
  getDb()
    .prepare(sql)
    .run(...keys.map((key) => (fields as Record<string, unknown>)[key]), id);
}

export function claimNextJob(now: number, workerId: string): PlanningJobRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM draft_planning_jobs
       WHERE status IN ('queued', 'generating')
         AND cancel_requested = 0
         AND (lease_until IS NULL OR lease_until < ?)
       ORDER BY queued_at ASC
       LIMIT 1`,
    )
    .get(now) as PlanningJobRow | undefined;
  if (!row) return null;
  const generation = row.lease_generation + 1;
  const result = db
    .prepare(
      `UPDATE draft_planning_jobs
       SET status = 'generating',
           lease_until = ?,
           lease_generation = ?,
           attempt = CASE WHEN status = 'queued' THEN attempt + 1 ELSE attempt END,
           started_at = COALESCE(started_at, ?),
           deadline_at = COALESCE(deadline_at, ?)
       WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .run(
      now + PLANNING_LIMITS.jobTimeoutMs,
      generation,
      now,
      now + PLANNING_LIMITS.jobTimeoutMs,
      row.id,
      now,
    );
  if (result.changes !== 1) return null;
  void workerId;
  return getJobById(row.id);
}

export function insertPlanRevision(row: DraftPlanRow): void {
  getDb()
    .prepare(
      `INSERT INTO draft_plans (
        id, revision, team_id, plan_hash, status, source_json, source_hash,
        plan_json, normalized_json, issues_json, context_fingerprint,
        committed_batch_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.revision,
      row.team_id,
      row.plan_hash,
      row.status,
      row.source_json,
      row.source_hash,
      row.plan_json,
      row.normalized_json,
      row.issues_json,
      row.context_fingerprint,
      row.committed_batch_id,
      row.created_at,
      row.expires_at,
    );
}

export function getPlanRevision(
  teamId: string,
  planId: string,
  revision?: number,
): DraftPlanRow | null {
  if (revision != null) {
    return (
      (getDb()
        .prepare(`SELECT * FROM draft_plans WHERE team_id = ? AND id = ? AND revision = ?`)
        .get(teamId, planId, revision) as DraftPlanRow | undefined) || null
    );
  }
  return (
    (getDb()
      .prepare(
        `SELECT * FROM draft_plans WHERE team_id = ? AND id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(teamId, planId) as DraftPlanRow | undefined) || null
  );
}

export function markPlanCommitted(
  teamId: string,
  planId: string,
  revision: number,
  batchId: string,
): void {
  getDb()
    .prepare(
      `UPDATE draft_plans SET status = 'committed', committed_batch_id = ? WHERE team_id = ? AND id = ? AND revision = ?`,
    )
    .run(batchId, teamId, planId, revision);
}

export function insertBatch(row: DraftBatchRow): void {
  getDb()
    .prepare(
      `INSERT INTO draft_batches (
        id, team_id, plan_id, revision, request_id, receipt_json, status, undo_until, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.team_id,
      row.plan_id,
      row.revision,
      row.request_id,
      row.receipt_json,
      row.status,
      row.undo_until,
      row.committed_at,
    );
}

export function getBatch(teamId: string, batchId: string): DraftBatchRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM draft_batches WHERE team_id = ? AND id = ?`)
      .get(teamId, batchId) as DraftBatchRow | undefined) || null
  );
}

export function getBatchByPlan(teamId: string, planId: string): DraftBatchRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM draft_batches WHERE team_id = ? AND plan_id = ?`)
      .get(teamId, planId) as DraftBatchRow | undefined) || null
  );
}

export function insertBatchItem(row: DraftBatchItemRow): void {
  getDb()
    .prepare(
      `INSERT INTO draft_batch_rows (
        batch_id, ref, kind, item_key, sub_id, existing, written_version, handoff_state, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.batch_id,
      row.ref,
      row.kind,
      row.item_key,
      row.sub_id,
      row.existing,
      row.written_version,
      row.handoff_state,
      row.snapshot_json,
    );
}

export function listBatchItems(batchId: string): DraftBatchItemRow[] {
  return getDb()
    .prepare(`SELECT * FROM draft_batch_rows WHERE batch_id = ?`)
    .all(batchId) as DraftBatchItemRow[];
}

export function findBatchItemBySub(teamId: string, subId: string): DraftBatchItemRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT r.* FROM draft_batch_rows r
         JOIN draft_batches b ON b.id = r.batch_id
         WHERE b.team_id = ? AND r.sub_id = ?
         ORDER BY b.committed_at DESC LIMIT 1`,
      )
      .get(teamId, subId) as DraftBatchItemRow | undefined) || null
  );
}

export function findBatchItemByItemKey(
  teamId: string,
  itemKey: string,
): DraftBatchItemRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT r.* FROM draft_batch_rows r
         JOIN draft_batches b ON b.id = r.batch_id
         WHERE b.team_id = ? AND r.item_key = ? AND r.kind = 'parent'
         ORDER BY b.committed_at DESC LIMIT 1`,
      )
      .get(teamId, itemKey) as DraftBatchItemRow | undefined) || null
  );
}

export function updateBatchStatus(
  teamId: string,
  batchId: string,
  status: string,
  receipt?: BatchReceipt,
): void {
  if (receipt) {
    getDb()
      .prepare(
        `UPDATE draft_batches SET status = ?, receipt_json = ? WHERE team_id = ? AND id = ?`,
      )
      .run(status, JSON.stringify(receipt), teamId, batchId);
    return;
  }
  getDb()
    .prepare(`UPDATE draft_batches SET status = ? WHERE team_id = ? AND id = ?`)
    .run(status, teamId, batchId);
}

export function markHandoff(
  teamId: string,
  refs: Array<{ itemKey?: string; subId?: string }>,
  state: string,
): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  for (const ref of refs) {
    const row = ref.subId
      ? findBatchItemBySub(teamId, ref.subId)
      : ref.itemKey
        ? findBatchItemByItemKey(teamId, ref.itemKey)
        : null;
    if (!row) continue;
    const batch = getBatch(teamId, row.batch_id);
    if (!batch || batch.status === 'undone') {
      return { ok: false, error: 'batch_unavailable' };
    }
    db.prepare(
      `UPDATE draft_batch_rows SET handoff_state = ? WHERE batch_id = ? AND ref = ?`,
    ).run(state, row.batch_id, row.ref);
    if (state === 'in_progress' || state === 'unknown_outcome' || state === 'linked') {
      db.prepare(
        `UPDATE draft_batches SET status = CASE WHEN status = 'undone' THEN status ELSE 'jira_in_progress' END
         WHERE id = ?`,
      ).run(row.batch_id);
    }
  }
  return { ok: true };
}

export function newId(size = 12): string {
  return nanoid(size);
}

export function parseNormalized(row: DraftPlanRow): NormalizedDraftPlan {
  return JSON.parse(row.normalized_json) as NormalizedDraftPlan;
}

export function parseReceipt(row: DraftBatchRow): BatchReceipt {
  return JSON.parse(row.receipt_json) as BatchReceipt;
}
