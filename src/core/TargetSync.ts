import { config } from '../config.js';
import { getDb } from '../storage/Database.js';
import type { ActorContext, ItemRow, SubRow } from '../types.js';
import {
  addIsoDays,
  jiraUpdateTargetDates,
  JiraHttpError,
} from './JiraClient.js';

type PendingTarget = {
  actor: ActorContext;
  teamId: string;
  itemKey?: string;
  subId?: string;
};

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTargets = new Map<string, PendingTarget>();

const DEBOUNCE_MS = 1500;

function mapItemKey(teamId: string, itemKey: string) {
  return `item:${teamId}:${itemKey}`;
}

function mapSubKey(teamId: string, subId: string) {
  return `sub:${teamId}:${subId}`;
}

function enqueue(key: string, pending: PendingTarget): { queued: boolean; skipped?: string } {
  if (!config.jira.enabled) {
    return { queued: false, skipped: 'jira_not_configured' };
  }
  pendingTargets.set(key, pending);
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      const next = pendingTargets.get(key) || pending;
      pendingTargets.delete(key);
      void flushPending(next);
    }, DEBOUNCE_MS),
  );
  return { queued: true };
}

/**
 * Debounced side-path using server JIRA_PAT. Returns whether the sync was
 * queued; when Jira is not configured, returns skipped (silent no-op).
 */
export function queueTargetSync(
  teamId: string,
  itemKey: string,
  actor: ActorContext,
): { queued: boolean; skipped?: string } {
  return enqueue(mapItemKey(teamId, itemKey), { actor, teamId, itemKey });
}

export function queueSubTargetSync(
  teamId: string,
  subId: string,
  actor: ActorContext,
): { queued: boolean; skipped?: string } {
  return enqueue(mapSubKey(teamId, subId), { actor, teamId, subId });
}

export function hasPendingTargetSync(
  teamId: string,
  ref: { itemKey?: string; subId?: string },
): boolean {
  if (ref.subId) return pendingTargets.has(mapSubKey(teamId, ref.subId));
  if (ref.itemKey) return pendingTargets.has(mapItemKey(teamId, ref.itemKey));
  return false;
}

/** Test helper — clear pending timers without flushing. */
export function clearTargetSyncQueue(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  pendingTargets.clear();
}

/** Test helper — run due syncs immediately (skips remaining debounce). */
export async function flushAllTargetSyncs(): Promise<void> {
  const keys = [...debounceTimers.keys()];
  for (const k of keys) {
    const timer = debounceTimers.get(k);
    if (timer) clearTimeout(timer);
    debounceTimers.delete(k);
    const pending = pendingTargets.get(k);
    pendingTargets.delete(k);
    if (pending) await flushPending(pending);
  }
}

async function flushPending(pending: PendingTarget): Promise<void> {
  if (pending.subId) {
    await flushSubTargetSync(pending.teamId, pending.subId, pending.actor);
    return;
  }
  if (pending.itemKey) {
    await flushTargetSync(pending.teamId, pending.itemKey, pending.actor);
  }
}

async function writeSyncResult(input: {
  teamId: string;
  actor: ActorContext;
  ok: boolean;
  targetType: 'item' | 'sub';
  targetKey: string;
  title: string;
  alias: string | null;
  jiraKey: string;
  start: string;
  end: string;
  status?: number;
  error?: string;
}): Promise<void> {
  const { writeActivity, getTeamSnapshot } = await import('./TeamService.js');
  const { getEventBus } = await import('./EventBus.js');
  writeActivity({
    teamId: input.teamId,
    actor: input.actor,
    op: input.ok ? 'jira_sync' : 'jira_sync_failed',
    targetType: input.targetType,
    targetKey: input.targetKey,
    summary: {
      title: input.title,
      alias: input.alias,
      jiraKey: input.jiraKey,
      start: input.start,
      end: input.end,
      status: input.status,
      error: input.error,
    },
  });
  if (input.ok) {
    const snapshot = getTeamSnapshot(input.teamId);
    if (snapshot) getEventBus().emit('snapshot', snapshot, input.teamId);
  }
}

async function flushTargetSync(
  teamId: string,
  itemKey: string,
  actor: ActorContext,
): Promise<void> {
  if (!config.jira.enabled) return;
  const db = getDb();
  const item = db
    .prepare(`SELECT * FROM items WHERE team_id = ? AND key = ?`)
    .get(teamId, itemKey) as ItemRow | undefined;
  if (!item?.jira_key || !item.start_date || !item.days) return;

  const start = item.start_date;
  const end = addIsoDays(start, Math.max(1, item.days) - 1);
  const jiraKey = item.jira_key;

  try {
    await jiraUpdateTargetDates(jiraKey, start, end);
    const ts = Date.now();
    db.prepare(
      `UPDATE items SET target_start = ?, target_end = ?, updated_at = ?
       WHERE team_id = ? AND key = ?`,
    ).run(start, end, ts, teamId, itemKey);
    await writeSyncResult({
      teamId,
      actor,
      ok: true,
      targetType: 'item',
      targetKey: itemKey,
      title: item.title,
      alias: item.alias,
      jiraKey,
      start,
      end,
    });
  } catch (err) {
    const status = err instanceof JiraHttpError ? err.status : 0;
    const snippet =
      err instanceof JiraHttpError
        ? err.bodySnippet
        : err instanceof Error
          ? err.message
          : String(err);
    await writeSyncResult({
      teamId,
      actor,
      ok: false,
      targetType: 'item',
      targetKey: itemKey,
      title: item.title,
      alias: item.alias,
      jiraKey,
      start,
      end,
      status,
      error: snippet.slice(0, 200),
    });
  }
}

async function flushSubTargetSync(
  teamId: string,
  subId: string,
  actor: ActorContext,
): Promise<void> {
  if (!config.jira.enabled) return;
  const db = getDb();
  const sub = db
    .prepare(`SELECT * FROM subs WHERE team_id = ? AND id = ?`)
    .get(teamId, subId) as SubRow | undefined;
  if (!sub?.jira_key || !sub.start_date || !sub.days) return;

  const start = sub.start_date;
  const end = addIsoDays(start, Math.max(1, sub.days) - 1);
  const jiraKey = sub.jira_key;

  try {
    await jiraUpdateTargetDates(jiraKey, start, end);
    const ts = Date.now();
    db.prepare(
      `UPDATE subs SET target_start = ?, target_end = ?, updated_at = ?
       WHERE id = ?`,
    ).run(start, end, ts, subId);
    await writeSyncResult({
      teamId,
      actor,
      ok: true,
      targetType: 'sub',
      targetKey: subId,
      title: sub.title,
      alias: sub.alias,
      jiraKey,
      start,
      end,
    });
  } catch (err) {
    const status = err instanceof JiraHttpError ? err.status : 0;
    const snippet =
      err instanceof JiraHttpError
        ? err.bodySnippet
        : err instanceof Error
          ? err.message
          : String(err);
    await writeSyncResult({
      teamId,
      actor,
      ok: false,
      targetType: 'sub',
      targetKey: subId,
      title: sub.title,
      alias: sub.alias,
      jiraKey,
      start,
      end,
      status,
      error: snippet.slice(0, 200),
    });
  }
}
