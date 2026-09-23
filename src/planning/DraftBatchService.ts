import { nanoid } from 'nanoid';
import { getDb } from '../storage/Database.js';
import { buildJqlHints } from '../core/JqlIntrospect.js';
import type { ActorContext, ItemRow, SubRow } from '../types.js';
import {
  PLANNING_LIMITS,
  type BatchReceipt,
  type NormalizedDraftPlan,
  type NormalizedParent,
  type PlanningIssue,
} from './contracts.js';
import { emitTeamEvent, runWithBufferedEvents } from './eventBuffer.js';
import {
  getBatch,
  getBatchByPlan,
  insertBatch,
  insertBatchItem,
  listBatchItems,
  markPlanCommitted,
  parseNormalized,
  parseReceipt,
  updateBatchStatus,
  type DraftPlanRow,
} from './PlanningStore.js';

export type CommitResult =
  | { ok: true; receipt: BatchReceipt }
  | { ok: false; error: string; status?: number; issues?: PlanningIssue[] };

export function commitNormalizedPlan(input: {
  teamId: string;
  requestId: string;
  planRow: DraftPlanRow;
  normalized: NormalizedDraftPlan;
  actor: ActorContext;
  decisions?: Record<string, string>;
  publicBaseUrl?: string;
  quarter?: string | null;
}): CommitResult {
  const existing = getBatchByPlan(input.teamId, input.planRow.id);
  if (existing) {
    const receipt = parseReceipt(existing);
    if (existing.status === 'undone') {
      return {
        ok: false,
        error: 'plan_undone',
        status: 409,
        issues: [
          {
            code: 'duplicate_batch',
            severity: 'error',
            message: '该计划已撤销；重建需要新的 requestId / plan',
          },
        ],
      };
    }
    return { ok: true, receipt };
  }
  if (input.planRow.status === 'committed') {
    return { ok: false, error: 'plan_committed', status: 409 };
  }
  const hash = parseNormalized(input.planRow).hash;
  if (hash !== input.normalized.hash) {
    return { ok: false, error: 'plan_hash_mismatch', status: 409 };
  }
  const decisions = input.decisions || {};
  const blocking = input.normalized.issues.filter((issue) => {
    if (issue.severity === 'error') return true;
    if (issue.severity !== 'decision' || !issue.decisionId) return false;
    return !decisions[issue.decisionId];
  });
  if (blocking.length) {
    return { ok: false, error: 'needs_input', status: 422, issues: blocking };
  }

  const now = Date.now();
  const batchId = nanoid(12);
  let receipt: BatchReceipt | null = null;

  try {
    runWithBufferedEvents(() => {
      getDb().transaction(() => {
        receipt = writeBatch({
          ...input,
          batchId,
          now,
          decisions,
        });
      })();
    });
  } catch (error) {
    const err = error as Error & { rollbackError?: string };
    return {
      ok: false,
      error: err.rollbackError || err.message || 'commit_failed',
      status: 500,
    };
  }

  if (!receipt) return { ok: false, error: 'commit_failed', status: 500 };
  emitTeamEvent(
    'planning',
    { type: 'batch_committed', batchId, requestId: input.requestId },
    input.teamId,
  );
  return { ok: true, receipt };
}

function writeBatch(input: {
  teamId: string;
  requestId: string;
  planRow: DraftPlanRow;
  normalized: NormalizedDraftPlan;
  actor: ActorContext;
  decisions: Record<string, string>;
  publicBaseUrl?: string;
  quarter?: string | null;
  batchId: string;
  now: number;
}): BatchReceipt {
  const db = getDb();
  const team = db.prepare(`SELECT * FROM teams WHERE id = ?`).get(input.teamId) as
    | { id: string; jql: string }
    | undefined;
  if (!team) throw Object.assign(new Error('team_not_found'), { rollbackError: 'team_not_found' });

  const createdParents: string[] = [];
  const attachedParents: string[] = [];
  const createdChildren: string[] = [];
  const refMappings: BatchReceipt['refMappings'] = {};
  let lane = nextLane(input.teamId);

  const hints = buildJqlHints({
    jql: team.jql,
    modeItemType: modeItemType(input.teamId),
  });

  for (const parent of input.normalized.parents) {
    if (parent.action === 'attach' && parent.existingItemKey) {
      const item = getItemRow(input.teamId, parent.existingItemKey);
      if (!item) {
        throw Object.assign(new Error('parent_missing'), { rollbackError: 'parent_missing' });
      }
      applyParentDecisions(input, parent, item);
      attachedParents.push(item.key);
      refMappings[parent.ref] = { itemKey: item.key };
      insertBatchItem({
        batch_id: input.batchId,
        ref: parent.ref,
        kind: 'parent',
        item_key: item.key,
        sub_id: null,
        existing: 1,
        written_version: getItemRow(input.teamId, item.key)?.version || item.version,
        handoff_state: null,
        snapshot_json: JSON.stringify(item),
      });
      writeChildren(input, parent, item.key, createdChildren, refMappings);
      continue;
    }

    const key = localItemKey(input.teamId);
    const scheduleParent = true;
    db.prepare(
      `INSERT INTO items (
        id, team_id, key, type, title, alias, quarter, estimate,
        target_start, target_end, scheduled, start_date, days, lane,
        expanded, source, jira_key, project_key, description, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 'manual', NULL, ?, ?, 1, ?, ?)`,
    ).run(
      nanoid(12),
      input.teamId,
      key,
      hints.itemType || 'Epic',
      parent.title,
      input.quarter || null,
      parent.schedule.writeTargetDates ? parent.schedule.targetStart : null,
      parent.schedule.writeTargetDates ? parent.schedule.targetEnd : null,
      scheduleParent ? 1 : 0,
      parent.schedule.start,
      parent.schedule.days,
      lane++,
      hints.projectKey,
      parent.description || null,
      input.now,
      input.now,
    );
    createdParents.push(key);
    refMappings[parent.ref] = { itemKey: key };
    insertBatchItem({
      batch_id: input.batchId,
      ref: parent.ref,
      kind: 'parent',
      item_key: key,
      sub_id: null,
      existing: 0,
      written_version: 1,
      handoff_state: null,
      snapshot_json: JSON.stringify(getItemRow(input.teamId, key)),
    });
    writeActivity(input, 'add_item', 'item', key, { title: parent.title, source: 'web_ai' });
    writeChildren(input, parent, key, createdChildren, refMappings);
  }

  const receipt: BatchReceipt = {
    batchId: input.batchId,
    requestId: input.requestId,
    planId: input.planRow.id,
    revision: input.planRow.revision,
    createdParents,
    attachedParents,
    createdChildren,
    refMappings,
    warnings: input.normalized.warnings,
    assumptions: input.normalized.assumptions,
    roadmapUrl: publicRoadmapUrl(input.publicBaseUrl, input.teamId),
    committedAt: input.now,
    jiraCreated: false,
  };

  insertBatch({
    id: input.batchId,
    team_id: input.teamId,
    plan_id: input.planRow.id,
    revision: input.planRow.revision,
    request_id: input.requestId,
    receipt_json: JSON.stringify(receipt),
    status: 'committed',
    undo_until: input.now + PLANNING_LIMITS.undoWindowMs,
    committed_at: input.now,
  });
  markPlanCommitted(input.teamId, input.planRow.id, input.planRow.revision, input.batchId);
  return receipt;
}

function writeChildren(
  input: {
    teamId: string;
    actor: ActorContext;
    now: number;
    batchId: string;
    decisions: Record<string, string>;
    normalized: NormalizedDraftPlan;
  },
  parent: NormalizedParent,
  itemKey: string,
  createdChildren: string[],
  refMappings: BatchReceipt['refMappings'],
): void {
  const db = getDb();
  for (const child of parent.children) {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO subs (
        id, team_id, item_key, jira_key, title, alias, owner,
        start_date, days, is_draft, cleared, created_by, description,
        owner_resolution, version, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, 1, 0, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.teamId,
      itemKey,
      child.title,
      child.owner,
      child.schedule.start,
      child.schedule.days,
      input.actor.name,
      child.description || null,
      child.ownerResolution,
      input.now,
      input.now,
    );
    if (child.owner) ensureMemberRow(input.teamId, child.owner, input.now);
    createdChildren.push(id);
    refMappings[child.ref] = { itemKey, subId: id };
    insertBatchItem({
      batch_id: input.batchId,
      ref: child.ref,
      kind: 'child',
      item_key: itemKey,
      sub_id: id,
      existing: 0,
      written_version: 1,
      handoff_state: null,
      snapshot_json: JSON.stringify(
        db.prepare(`SELECT * FROM subs WHERE id = ?`).get(id),
      ),
    });
    writeActivity(input, 'add_sub', 'sub', id, {
      title: child.title,
      parent: itemKey,
      owner: child.owner,
      ownerResolution: child.ownerResolution,
      source: 'web_ai',
    });
  }
}

function applyParentDecisions(
  input: {
    teamId: string;
    now: number;
    decisions: Record<string, string>;
  },
  parent: NormalizedParent,
  item: ItemRow,
): void {
  const db = getDb();
  for (const patch of parent.parentPatches) {
    const choice = input.decisions[patch.decisionId];
    const emptyBefore = patch.before == null || patch.before === '';
    if (choice !== 'apply' && choice !== 'schedule' && !emptyBefore) continue;
    const current = getItemRow(input.teamId, item.key);
    if (!current) throw Object.assign(new Error('parent_missing'), { rollbackError: 'parent_missing' });
    if (current.version !== patch.baseVersion || current.description !== patch.before) {
      throw Object.assign(new Error('version_conflict'), { rollbackError: 'version_conflict' });
    }
    if (patch.field === 'description') {
      db.prepare(
        `UPDATE items SET description = ?, version = version + 1, updated_at = ? WHERE team_id = ? AND key = ?`,
      ).run(patch.after, input.now, input.teamId, item.key);
    }
  }
  const scheduleDecision = input.decisions[`schedule-parent:${item.key}`];
  if (scheduleDecision === 'schedule' && !item.scheduled) {
    db.prepare(
      `UPDATE items SET scheduled = 1, start_date = ?, days = ?, lane = ?, version = version + 1, updated_at = ?
       WHERE team_id = ? AND key = ?`,
    ).run(
      parent.schedule.start,
      parent.schedule.days,
      nextLane(input.teamId),
      input.now,
      input.teamId,
      item.key,
    );
  }
  const fit = input.decisions[`fit-parent:${item.key}`];
  if (fit === 'extend_parent' && item.scheduled) {
    db.prepare(
      `UPDATE items SET start_date = ?, days = ?, version = version + 1, updated_at = ?
       WHERE team_id = ? AND key = ?`,
    ).run(
      parent.schedule.start,
      parent.schedule.days,
      input.now,
      input.teamId,
      item.key,
    );
  }
}

export function undoBatch(input: {
  teamId: string;
  batchId: string;
  actor: ActorContext;
  now?: number;
}): CommitResult {
  const batch = getBatch(input.teamId, input.batchId);
  if (!batch) return { ok: false, error: 'batch_not_found', status: 404 };
  if (batch.status === 'undone') {
    const receipt = parseReceipt(batch);
    return { ok: true, receipt: { ...receipt, undone: true } };
  }
  const now = input.now ?? Date.now();
  if (now > batch.undo_until) {
    return { ok: false, error: 'undo_expired', status: 409 };
  }
  const rows = listBatchItems(batch.id);
  const conflicts: string[] = [];
  for (const row of rows) {
    if (row.existing) {
      if (row.kind === 'parent' && row.item_key) {
        const item = getItemRow(input.teamId, row.item_key);
        if (item && row.written_version != null && item.version !== row.written_version) {
          conflicts.push(`${row.ref}:parent_edited`);
        }
      }
      continue;
    }
    if (row.kind === 'parent' && row.item_key) {
      const item = getItemRow(input.teamId, row.item_key);
      if (!item) continue;
      if (item.jira_key) conflicts.push(`${row.ref}:has_jira`);
      if (item.version !== row.written_version) conflicts.push(`${row.ref}:edited`);
      const extra = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM subs WHERE team_id = ? AND item_key = ? AND id NOT IN (
            SELECT sub_id FROM draft_batch_rows WHERE batch_id = ? AND sub_id IS NOT NULL
          )`,
        )
        .get(input.teamId, item.key, batch.id) as { n: number };
      if (extra.n > 0) conflicts.push(`${row.ref}:extra_children`);
    }
    if (row.kind === 'child' && row.sub_id) {
      const sub = getSubRow(row.sub_id);
      if (!sub) continue;
      if (sub.jira_key) conflicts.push(`${row.ref}:has_jira`);
      if (sub.version !== row.written_version) conflicts.push(`${row.ref}:edited`);
    }
  }
  if (conflicts.length) {
    return {
      ok: false,
      error: 'undo_conflict',
      status: 409,
      issues: conflicts.map((message) => ({
        code: 'version_conflict',
        severity: 'error',
        message,
      })),
    };
  }

  runWithBufferedEvents(() => {
    getDb().transaction(() => {
      const db = getDb();
      for (const row of rows) {
        if (row.existing) continue;
        if (row.kind === 'child' && row.sub_id) {
          db.prepare(`DELETE FROM subs WHERE team_id = ? AND id = ?`).run(
            input.teamId,
            row.sub_id,
          );
        }
      }
      for (const row of rows) {
        if (row.existing || row.kind !== 'parent' || !row.item_key) continue;
        db.prepare(`DELETE FROM item_markers WHERE team_id = ? AND item_key = ?`).run(
          input.teamId,
          row.item_key,
        );
        db.prepare(`DELETE FROM items WHERE team_id = ? AND key = ?`).run(
          input.teamId,
          row.item_key,
        );
      }
      for (const row of rows) {
        if (!row.existing || row.kind !== 'parent' || !row.item_key) continue;
        const snap = row.snapshot_json ? (JSON.parse(row.snapshot_json) as ItemRow) : null;
        if (!snap) continue;
        db.prepare(
          `UPDATE items SET description = ?, start_date = ?, days = ?, scheduled = ?, version = ?, updated_at = ?
           WHERE team_id = ? AND key = ? AND version = ?`,
        ).run(
          snap.description,
          snap.start_date,
          snap.days,
          snap.scheduled,
          snap.version,
          now,
          input.teamId,
          row.item_key,
          row.written_version,
        );
      }
      db.prepare(
        `UPDATE draft_batch_rows SET handoff_state = 'undone' WHERE batch_id = ?`,
      ).run(batch.id);
      const receipt = { ...parseReceipt(batch), undone: true as const };
      updateBatchStatus(input.teamId, batch.id, 'undone', receipt);
    })();
  });
  emitTeamEvent('planning', { type: 'batch_undone', batchId: batch.id }, input.teamId);
  return { ok: true, receipt: { ...parseReceipt(batch), undone: true } };
}

export function restoreUndoneRow(input: {
  teamId: string;
  itemKey?: string;
  subId?: string;
  jiraKey: string;
}): boolean {
  const db = getDb();
  const row = input.subId
    ? (db
        .prepare(
          `SELECT r.* FROM draft_batch_rows r
           JOIN draft_batches b ON b.id = r.batch_id
           WHERE b.team_id = ? AND r.sub_id = ? AND r.handoff_state = 'undone'`,
        )
        .get(input.teamId, input.subId) as
        | {
            snapshot_json: string;
            sub_id: string;
            item_key: string;
            batch_id: string;
            ref: string;
          }
        | undefined)
    : input.itemKey
      ? (db
          .prepare(
            `SELECT r.* FROM draft_batch_rows r
             JOIN draft_batches b ON b.id = r.batch_id
             WHERE b.team_id = ? AND r.item_key = ? AND r.kind = 'parent' AND r.handoff_state = 'undone'`,
          )
          .get(input.teamId, input.itemKey) as
          | {
              snapshot_json: string;
              sub_id: string | null;
              item_key: string;
              batch_id: string;
              ref: string;
            }
          | undefined)
      : undefined;
  if (!row?.snapshot_json) return false;
  const snap = JSON.parse(row.snapshot_json) as Record<string, unknown>;
  if (input.subId) {
    const existing = getSubRow(input.subId);
    if (existing) return false;
    db.prepare(
      `INSERT INTO subs (
        id, team_id, item_key, jira_key, title, alias, owner,
        start_date, days, is_draft, cleared, created_by, description,
        owner_resolution, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 1, ?, ?)`,
    ).run(
      snap.id,
      snap.team_id,
      snap.item_key,
      input.jiraKey,
      snap.title,
      snap.alias,
      snap.owner,
      snap.start_date,
      snap.days,
      snap.created_by,
      snap.description,
      snap.owner_resolution || 'legacy',
      Date.now(),
      Date.now(),
    );
  } else if (input.itemKey) {
    const existing = getItemRow(input.teamId, input.itemKey);
    if (existing) return false;
    db.prepare(
      `INSERT INTO items (
        id, team_id, key, type, title, alias, quarter, estimate,
        target_start, target_end, scheduled, start_date, days, lane,
        expanded, source, jira_key, project_key, description, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      snap.id,
      snap.team_id,
      snap.key,
      snap.type,
      snap.title,
      snap.alias,
      snap.quarter,
      snap.estimate,
      snap.target_start,
      snap.target_end,
      snap.scheduled,
      snap.start_date,
      snap.days,
      snap.lane,
      snap.expanded,
      snap.source || 'manual',
      input.jiraKey,
      snap.project_key,
      snap.description,
      Date.now(),
      Date.now(),
    );
  }
  db.prepare(
    `UPDATE draft_batch_rows SET handoff_state = 'linked' WHERE batch_id = ? AND ref = ?`,
  ).run(row.batch_id, row.ref);
  return true;
}

function writeActivity(
  input: { teamId: string; actor: ActorContext; now: number },
  op: string,
  targetType: string,
  targetKey: string,
  summary: Record<string, unknown>,
): void {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO activity_log (
        id, team_id, at, actor_name, actor_client_id, actor_source,
        op, target_type, target_key, summary_json, share_token_id, ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.teamId,
      input.now,
      input.actor.name,
      input.actor.clientId,
      input.actor.source,
      op,
      targetType,
      targetKey,
      JSON.stringify(summary),
      input.actor.shareTokenId || null,
      input.actor.ip || null,
    );
  emitTeamEvent(
    'activity',
    {
      id,
      teamId: input.teamId,
      at: input.now,
      actorName: input.actor.name,
      actorClientId: input.actor.clientId,
      actorSource: input.actor.source,
      op,
      targetType,
      targetKey,
      summary,
    },
    input.teamId,
  );
}

function localItemKey(teamId: string): string {
  const db = getDb();
  for (let i = 0; i < 8; i += 1) {
    const key = `LOCAL-${nanoid(8)}`;
    const exists = db
      .prepare(`SELECT 1 FROM items WHERE team_id = ? AND key = ?`)
      .get(teamId, key);
    if (!exists) return key;
  }
  return `LOCAL-${nanoid(12)}`;
}

function nextLane(teamId: string): number {
  const row = getDb()
    .prepare(
      `SELECT MAX(lane) AS m FROM items WHERE team_id = ? AND scheduled = 1`,
    )
    .get(teamId) as { m: number | null };
  return (row?.m ?? -1) + 1;
}

function modeItemType(teamId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT type FROM items
       WHERE team_id = ? AND source = 'jira' AND type IS NOT NULL AND TRIM(type) != ''
       GROUP BY type ORDER BY COUNT(*) DESC, type ASC LIMIT 1`,
    )
    .get(teamId) as { type: string } | undefined;
  return row?.type || null;
}

function getItemRow(teamId: string, key: string): ItemRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM items WHERE team_id = ? AND key = ?`)
      .get(teamId, key) as ItemRow | undefined) || null
  );
}

function getSubRow(id: string): SubRow | null {
  return (
    (getDb().prepare(`SELECT * FROM subs WHERE id = ?`).get(id) as SubRow | undefined) ||
    null
  );
}

function ensureMemberRow(teamId: string, name: string, now: number): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO members (id, team_id, name, avatar_color, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(nanoid(10), teamId, trimmed, '#5B8DEF', now);
}

function publicRoadmapUrl(base: string | undefined, teamId: string): string {
  const root = (base || '').replace(/\/$/, '');
  return root ? `${root}/?team=${encodeURIComponent(teamId)}` : `/?team=${encodeURIComponent(teamId)}`;
}

