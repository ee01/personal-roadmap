import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { getDb } from '../storage/Database.js';
import { emitTeamEvent } from '../planning/eventBuffer.js';
import { publicIntentEvent } from '../planning/sanitize.js';
import { restoreUndoneRow } from '../planning/DraftBatchService.js';
import { config } from '../config.js';
import { buildJqlHints } from './JqlIntrospect.js';
import type {
  ActivityRow,
  ActorContext,
  EtaSource,
  IntentOp,
  ItemRow,
  ItemSource,
  MarkerKind,
  MarkerRow,
  MemberRow,
  PhaseKind,
  ReleaseSheetConfig,
  SubRow,
  TeamRow,
  TeamSnapshot,
} from '../types.js';
import type { RemoteTask } from './JiraClient.js';
import { jiraSearchChildTasks } from './JiraClient.js';
import {
  addDaysIso,
  clipDescription,
  daysBetweenIso,
  importedTaskSpan,
  looksFullName,
  mergeAssigneeMapIdentities,
  migrateAssigneeMapKey,
  normalizeAssigneeMap,
  ownerMatchesAssignee,
  parseAssigneeMap,
} from './assigneeMap.js';
import { planDeferToTarget } from './deferPlan.js';
import { scheduleDivergesFromMirroredTarget } from './targetSchedule.js';
import {
  coerceOriginalEstimateDays,
  originalEstimateFromJiraFields,
} from './originalEstimate.js';

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeReleaseFilter(
  raw: unknown,
): ReleaseSheetConfig['releaseFilter'] {
  if (!raw || typeof raw !== 'object') return { mode: 'all', pattern: '' };
  const o = raw as Record<string, unknown>;
  const modeRaw = String(o.mode || 'all');
  const mode =
    modeRaw === 'major' || modeRaw === 'custom' ? modeRaw : 'all';
  const pattern = String(o.pattern || '').trim();
  if (mode === 'custom' && !pattern) return { mode: 'all', pattern: '' };
  return { mode, pattern: mode === 'custom' ? pattern : '' };
}

function parseReleaseSheet(
  raw: string | null | undefined,
): ReleaseSheetConfig | null {
  if (!raw || raw === 'null') return null;
  try {
    const parsed = JSON.parse(raw) as ReleaseSheetConfig | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.url || !parsed.spreadsheetId) return null;
    return {
      url: String(parsed.url),
      spreadsheetId: String(parsed.spreadsheetId),
      sheetName: String(parsed.sheetName || 'Sheet1'),
      range: String(parsed.range || 'A1:C500'),
      splitPhase: String(parsed.splitPhase || 'ff'),
      showPhases: Array.isArray(parsed.showPhases)
        ? parsed.showPhases.map(String)
        : [],
      releaseFilter: normalizeReleaseFilter(parsed.releaseFilter),
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      fetchedAt:
        typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
    };
  } catch {
    return null;
  }
}

function releaseSheetContentKey(sheet: ReleaseSheetConfig | null): string {
  if (!sheet) return '';
  return JSON.stringify({
    url: sheet.url,
    spreadsheetId: sheet.spreadsheetId,
    sheetName: sheet.sheetName,
    range: sheet.range,
    splitPhase: sheet.splitPhase,
    showPhases: sheet.showPhases,
    releaseFilter: sheet.releaseFilter || null,
    rows: sheet.rows,
  });
}

/** Validate + normalize a client-submitted releaseSheet payload (or null to clear). */
function normalizeReleaseSheetInput(
  raw: unknown,
): ReleaseSheetConfig | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const url = String(o.url || '').trim();
  const spreadsheetId = String(o.spreadsheetId || '').trim();
  if (!url || !spreadsheetId) return null;
  return {
    url,
    spreadsheetId,
    sheetName: String(o.sheetName || 'Sheet1').trim() || 'Sheet1',
    range: String(o.range || 'A1:C500').trim() || 'A1:C500',
    splitPhase: String(o.splitPhase || 'ff'),
    showPhases: Array.isArray(o.showPhases)
      ? o.showPhases.map(String)
      : [],
    releaseFilter: normalizeReleaseFilter(o.releaseFilter),
    rows: Array.isArray(o.rows)
      ? (o.rows as Array<Record<string, unknown>>)
      : [],
    fetchedAt:
      typeof o.fetchedAt === 'string'
        ? o.fetchedAt
        : o.fetchedAt
          ? new Date(o.fetchedAt as string | number | Date).toISOString()
          : null,
  };
}

function now(): number {
  return Date.now();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createShareTokenValue(): string {
  return `rw_${randomBytes(18).toString('base64url')}`;
}

export function hashShareToken(token: string): string {
  return hashToken(token);
}

function normalizeSource(raw: string | null | undefined): ItemSource {
  return raw === 'manual' ? 'manual' : 'jira';
}

function normalizeOwnerResolution(
  raw: string | null | undefined,
): NonNullable<TeamSnapshot['items'][number]['subs'][number]['ownerResolution']> {
  if (raw === 'explicit' || raw === 'ambiguous' || raw === 'unassigned' || raw === 'legacy') {
    return raw;
  }
  return 'legacy';
}

/** Derive the Jira project key from a real issue key (`NOVA-123` -> `NOVA`). */
function projectKeyFromJiraKey(key: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(key.trim());
  return match ? match[1].toUpperCase() : null;
}

function mapMarker(row: MarkerRow) {
  return {
    id: row.id,
    kind: row.kind,
    phaseKind: row.phase_kind,
    label: row.label,
    date: row.date,
    jiraKey: row.jira_key,
    etaSource: row.eta_source,
    jiraStatus: row.jira_status || null,
    jiraTargetEnd: row.jira_target_end || null,
    jiraFetchedAt: row.jira_fetched_at || null,
    createdBy: row.created_by,
    version: row.version,
  };
}

function mapItem(row: ItemRow, subs: SubRow[], markers: MarkerRow[] = []) {
  return {
    key: row.key,
    type: row.type,
    title: row.title,
    source: normalizeSource(row.source),
    jiraKey: row.jira_key,
    projectKey: row.project_key,
    alias: row.alias,
    quarter: row.quarter,
    estimate: row.estimate,
    targetStart: row.target_start,
    targetEnd: row.target_end,
    scheduled: Boolean(row.scheduled),
    start: row.start_date,
    days: row.days,
    lane: row.lane,
    expanded: Boolean(row.expanded),
    version: row.version,
    createdAt: row.created_at,
    description: row.description || null,
    status: row.status || null,
    subs: subs.map((sub) => ({
      id: sub.id,
      key: sub.jira_key,
      title: sub.title,
      alias: sub.alias,
      owner: sub.owner,
      start: sub.start_date,
      days: sub.days,
      targetStart: sub.target_start || null,
      targetEnd: sub.target_end || null,
      temp: Boolean(sub.is_draft),
      cleared: Boolean(sub.cleared),
      createdBy: sub.created_by,
      version: sub.version,
      description: sub.description || null,
      status: sub.status || null,
      originalEstimateDays:
        typeof sub.original_estimate_days === 'number'
          ? sub.original_estimate_days
          : null,
      ownerResolution: normalizeOwnerResolution(sub.owner_resolution),
    })),
    markers: markers.map(mapMarker),
  };
}

export function listTeams(ids?: string[]): Array<{
  id: string;
  name: string;
  jql: string;
  checkedQuarters: string[];
  importedQuarters: string[];
  version: number;
}> {
  const wanted = (ids || [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!wanted.length) return [];
  const db = getDb();
  const placeholders = wanted.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM teams WHERE id IN (${placeholders})`)
    .all(...wanted) as TeamRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return wanted
    .map((id) => byId.get(id))
    .filter((row): row is TeamRow => Boolean(row))
    .map((row) => ({
      id: row.id,
      name: row.name,
      jql: row.jql,
      checkedQuarters: parseJsonArray(row.checked_quarters_json),
      importedQuarters: parseJsonArray(row.imported_quarters_json),
      version: row.version,
    }));
}

export function getTeam(teamId: string): TeamRow | null {
  const db = getDb();
  return (
    (db.prepare(`SELECT * FROM teams WHERE id = ?`).get(teamId) as
      | TeamRow
      | undefined) || null
  );
}

/**
 * Most common `type` among the team's imported items — the fallback used when
 * the JQL itself does not name an issue type. Manual items are excluded because
 * their type is seeded from these very hints.
 */
function modeItemType(teamId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT type FROM items
       WHERE team_id = ? AND source = 'jira' AND type IS NOT NULL AND TRIM(type) != ''
       GROUP BY type
       ORDER BY COUNT(*) DESC, type ASC
       LIMIT 1`,
    )
    .get(teamId) as { type: string } | undefined;
  return row?.type || null;
}

export function getTeamSnapshot(teamId: string): TeamSnapshot | null {
  const db = getDb();
  const team = getTeam(teamId);
  if (!team) return null;

  const items = db
    .prepare(`SELECT * FROM items WHERE team_id = ? ORDER BY quarter, key`)
    .all(teamId) as ItemRow[];
  const subs = db
    .prepare(`SELECT * FROM subs WHERE team_id = ? ORDER BY created_at ASC`)
    .all(teamId) as SubRow[];
  const markers = db
    .prepare(
      `SELECT * FROM item_markers WHERE team_id = ? ORDER BY created_at ASC`,
    )
    .all(teamId) as MarkerRow[];
  const members = db
    .prepare(`SELECT * FROM members WHERE team_id = ? ORDER BY name ASC`)
    .all(teamId) as MemberRow[];

  const cutoff = now() - 60_000;
  const presence = db
    .prepare(
      `SELECT client_id, name, source, last_seen
       FROM presence
       WHERE team_id = ? AND last_seen >= ?
       ORDER BY last_seen DESC`,
    )
    .all(teamId, cutoff) as Array<{
    client_id: string;
    name: string;
    source: string;
    last_seen: number;
  }>;

  const locks = db
    .prepare(
      `SELECT target_type, target_key, actor_name, actor_client_id, expires_at
       FROM soft_locks
       WHERE team_id = ? AND expires_at > ?`,
    )
    .all(teamId, now()) as Array<{
    target_type: string;
    target_key: string;
    actor_name: string;
    actor_client_id: string;
    expires_at: number;
  }>;

  const subsByItem = new Map<string, SubRow[]>();
  for (const sub of subs) {
    const list = subsByItem.get(sub.item_key) || [];
    list.push(sub);
    subsByItem.set(sub.item_key, list);
  }
  const markersByItem = new Map<string, MarkerRow[]>();
  for (const marker of markers) {
    const list = markersByItem.get(marker.item_key) || [];
    list.push(marker);
    markersByItem.set(marker.item_key, list);
  }

  return {
    team: {
      id: team.id,
      name: team.name,
      jql: team.jql,
      checkedQuarters: parseJsonArray(team.checked_quarters_json),
      importedQuarters: parseJsonArray(team.imported_quarters_json),
      version: team.version,
      createdBy: team.created_by,
      jqlHints: buildJqlHints({
        jql: team.jql,
        modeItemType: modeItemType(teamId),
      }),
      jiraEnabled: config.jira.enabled,
      releaseSheet: parseReleaseSheet(team.release_sheet_json),
      createJiraPrompt: team.create_jira_prompt || '',
      assigneeMap: parseAssigneeMap(team.assignee_map_json),
      jiraBaseUrl: config.jira.baseUrl || '',
      jiraRefreshedAt: team.jira_refreshed_at || null,
    },
    items: items.map((item) =>
      mapItem(
        item,
        subsByItem.get(item.key) || [],
        markersByItem.get(item.key) || [],
      ),
    ),
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      avatarColor: m.avatar_color,
    })),
    presence: presence.map((p) => ({
      clientId: p.client_id,
      name: p.name,
      source: p.source as TeamSnapshot['presence'][number]['source'],
      lastSeen: p.last_seen,
    })),
    locks: locks.map((lock) => ({
      targetType: lock.target_type,
      targetKey: lock.target_key,
      actorName: lock.actor_name,
      actorClientId: lock.actor_client_id,
      expiresAt: lock.expires_at,
    })),
  };
}

export function createTeam(input: {
  name: string;
  jql: string;
  checkedQuarters?: string[];
  actor: ActorContext;
}): TeamSnapshot {
  const db = getDb();
  const id = nanoid(12);
  const ts = now();
  const checked = input.checkedQuarters || [];
  db.prepare(
    `INSERT INTO teams (
      id, name, jql, checked_quarters_json, imported_quarters_json,
      release_sheet_json, create_jira_prompt, assignee_map_json,
      version, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '[]', 'null', '', '{}', 1, ?, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    input.jql.trim(),
    JSON.stringify(checked),
    input.actor.name,
    ts,
    ts,
  );

  writeActivity({
    teamId: id,
    actor: input.actor,
    op: 'create_team',
    targetType: 'team',
    targetKey: id,
    summary: { name: input.name.trim() },
  });

  const snapshot = getTeamSnapshot(id)!;
  emitTeamEvent('team_created', snapshot, id);
  return snapshot;
}

export function validateShareToken(
  teamId: string,
  token: string | undefined | null,
): { ok: boolean; shareTokenId?: string } {
  if (!token) return { ok: false };
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id FROM share_tokens
       WHERE team_id = ? AND token_hash = ? AND revoked_at IS NULL`,
    )
    .get(teamId, hashShareToken(token)) as { id: string } | undefined;
  if (!row) return { ok: false };
  return { ok: true, shareTokenId: row.id };
}

export function createShareToken(
  teamId: string,
  actor: ActorContext,
): { token: string; id: string } {
  const db = getDb();
  const token = createShareTokenValue();
  const id = nanoid(10);
  db.prepare(
    `INSERT INTO share_tokens (id, team_id, token_hash, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, teamId, hashShareToken(token), actor.name, now());
  return { token, id };
}

export function touchPresence(
  teamId: string,
  actor: ActorContext,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO presence (team_id, client_id, name, source, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, client_id) DO UPDATE SET
       name = excluded.name,
       source = excluded.source,
       last_seen = excluded.last_seen`,
  ).run(teamId, actor.clientId, actor.name, actor.source, now());
  emitTeamEvent(
    'presence',
    { teamId, clientId: actor.clientId, name: actor.name, source: actor.source },
    teamId,
  );
}

export function writeActivity(input: {
  teamId: string;
  actor: ActorContext;
  op: IntentOp | string;
  targetType: string;
  targetKey?: string | null;
  summary?: Record<string, unknown>;
}): ActivityRow {
  const db = getDb();
  const id = nanoid(12);
  const at = now();
  db.prepare(
    `INSERT INTO activity_log (
      id, team_id, at, actor_name, actor_client_id, actor_source,
      op, target_type, target_key, summary_json, share_token_id, ip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.teamId,
    at,
    input.actor.name,
    input.actor.clientId,
    input.actor.source,
    input.op,
    input.targetType,
    input.targetKey || null,
    JSON.stringify(input.summary || {}),
    input.actor.shareTokenId || null,
    input.actor.ip || null,
  );

  const row: ActivityRow = {
    id,
    team_id: input.teamId,
    at,
    actor_name: input.actor.name,
    actor_client_id: input.actor.clientId,
    actor_source: input.actor.source,
    op: input.op,
    target_type: input.targetType,
    target_key: input.targetKey || null,
    summary_json: JSON.stringify(input.summary || {}),
    share_token_id: input.actor.shareTokenId || null,
    ip: input.actor.ip || null,
  };

  emitTeamEvent('activity', formatActivity(row), input.teamId);
  return row;
}

export function formatActivity(row: ActivityRow) {
  let summary: Record<string, unknown> = {};
  try {
    summary = JSON.parse(row.summary_json || '{}');
  } catch {
    summary = {};
  }
  return {
    id: row.id,
    teamId: row.team_id,
    at: row.at,
    actorName: row.actor_name,
    actorClientId: row.actor_client_id,
    actorSource: row.actor_source,
    op: row.op,
    targetType: row.target_type,
    targetKey: row.target_key,
    summary,
    text: renderActivityText(row, summary),
  };
}

export function renderActivityText(
  row: ActivityRow,
  summary: Record<string, unknown>,
): string {
  const who = row.actor_name || 'Someone';
  const label =
    (summary.alias as string) ||
    (summary.title as string) ||
    row.target_key ||
    '';
  switch (row.op) {
    case 'create_team':
      return `${who} 创建了团队 ${summary.name || label}`;
    case 'update_jql':
      return `${who} 更新了团队 JQL`;
    case 'update_release_sheet':
      if (summary.cleared) return `${who} 清除了发布时间表标尺`;
      if (summary.silent) return `${who} 静默更新了发布时间表标尺`;
      return `${who} 更新了发布时间表标尺`;
    case 'update_create_jira_prompt':
      return `${who} 更新了创建 Jira Prompt`;
    case 'update_assignee_map':
      return `${who} 更新了 Assignee 映射`;
    case 'merge_people':
      return `${who} 合并了人员 ${summary.from || ''} → ${summary.to || label}`;
    case 'import':
      return `${who} 导入了 ${(summary.quarters as string[])?.join(', ') || 'Backlog'}，${summary.count || 0} 项`;
    case 'schedule':
      return `${who} 把 ${label} 排进了 Gantt`;
    case 'unschedule':
      return `${who} 把 ${label} 退回 Backlog`;
    case 'move':
      return `${who} 把 ${label} 从 ${summary.from || '?'} 移到 ${summary.to || '?'}`;
    case 'resize':
      return `${who} 调整了 ${label} 的时长到 ${summary.days || '?'} 天`;
    case 'set_alias':
      return `${who} 把 ${summary.key || row.target_key} 备注名为 ${summary.alias || label}`;
    case 'update_item':
      return `${who} 更新了条目 ${label}`;
    case 'refresh_from_jira':
      return `Jira 刷新 · 经 ${who} 的扩展${
        summary.count ? `，更新 ${summary.count} 项` : ''
      }`;
    case 'add_item':
      return `${who} 新建了${summary.type ? `${summary.type} ` : ''}条目 ${label}`;
    case 'delete_item':
      return `${who} 删除了手动条目 ${label}`;
    case 'resolve_item':
      return `${who} 把 ${label} 创建为 ${summary.jiraKey || ''}`;
    case 'add_sub':
      return `${who} 给 ${summary.parent || row.target_key} 加了${summary.temp ? '草稿' : ''}任务 ${label}`;
    case 'update_sub':
      return `${who} 更新了任务 ${label}`;
    case 'delete_sub':
      return `${who} 删除了任务 ${label}`;
    case 'resolve_draft':
      return `${who} 将草稿 ${label} 创建为 ${summary.jiraKey || ''}`;
    case 'cleanup':
      return `${who} 清理了 ${summary.count || 0} 个过期任务`;
    case 'update_member':
      return `${who} 把成员 ${summary.from || ''} 改名为 ${summary.to || label}`;
    case 'add_marker':
      return `${who} 给 ${summary.parent || row.target_key} 添加了${
        summary.kind === 'dep' ? '外部依赖' : '节点'
      } ${label}`;
    case 'update_marker':
      return `${who} 更新了 ${label}${
        summary.etaSet ? `（ETA ${summary.date || ''}）` : ''
      }`;
    case 'delete_marker':
      return `${who} 删除了${
        summary.kind === 'dep' ? '外部依赖' : '节点'
      } ${label}`;
    case 'jira_sync':
      return `${who} 的排期变更已回写 ${summary.jiraKey || label} Target ${
        summary.start || '?'
      } → ${summary.end || '?'}`;
    case 'jira_sync_failed':
      return `${who} 回写 ${summary.jiraKey || label} Target 失败${
        summary.status ? `（HTTP ${summary.status}）` : ''
      }`;
    case 'import_tasks':
      return `${who} 导入了 ${summary.added || 0} 个 Task（跳过 ${
        summary.skipped || 0
      } 个已存在）`;
    case 'lock':
      return `${who} 正在编辑 ${label}`;
    default:
      return `${who} 执行了 ${row.op}${label ? ` · ${label}` : ''}`;
  }
}

export function listActivity(
  teamId: string,
  limit = 100,
): ReturnType<typeof formatActivity>[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM activity_log WHERE team_id = ? ORDER BY at DESC LIMIT ?`,
    )
    .all(teamId, limit) as ActivityRow[];
  return rows.map(formatActivity);
}

export function pruneOldActivity(): number {
  const db = getDb();
  const cutoff = now() - config.activityRetentionDays * 86_400_000;
  const result = db
    .prepare(`DELETE FROM activity_log WHERE at < ?`)
    .run(cutoff);
  return result.changes;
}

function getItem(teamId: string, key: string): ItemRow | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM items WHERE team_id = ? AND key = ?`)
      .get(teamId, key) as ItemRow | undefined) || null
  );
}

/**
 * Insert `movedKey` at `insertAt` among scheduled items and renumber lanes 0..n-1.
 * Without this, dragging up to an occupied lane leaves duplicates and the sort
 * looks like the row never moved.
 */
function reindexScheduledLanes(
  teamId: string,
  movedKey: string,
  insertAt: number,
  ts: number,
): void {
  const db = getDb();
  const scheduled = db
    .prepare(
      `SELECT key FROM items
       WHERE team_id = ? AND scheduled = 1
       ORDER BY lane ASC, key ASC`,
    )
    .all(teamId) as Array<{ key: string }>;
  const others = scheduled.map((r) => r.key).filter((k) => k !== movedKey);
  const at = Math.max(0, Math.min(Math.floor(insertAt), others.length));
  others.splice(at, 0, movedKey);
  const update = db.prepare(
    `UPDATE items SET lane = ?, updated_at = ? WHERE team_id = ? AND key = ?`,
  );
  others.forEach((key, index) => {
    update.run(index, ts, teamId, key);
  });
}

/**
 * Find the row already holding a Jira key. Used by import to recognise a manual
 * item whose Jira issue we created earlier, instead of inserting a duplicate.
 */
function getItemByJiraKey(teamId: string, jiraKey: string): ItemRow | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM items WHERE team_id = ? AND jira_key = ?`)
      .get(teamId, jiraKey) as ItemRow | undefined) || null
  );
}

/** Manual items keep this synthetic key forever; the real Jira key lands in `jira_key`. */
function generateLocalItemKey(teamId: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const key = `LOCAL-${nanoid(8)}`;
    if (!getItem(teamId, key)) return key;
  }
  return `LOCAL-${nanoid(12)}`;
}

function bumpItemVersion(teamId: string, key: string, baseVersion: number) {
  const item = getItem(teamId, key);
  if (!item) {
    return { ok: false as const, error: 'item_not_found' };
  }
  if (item.version !== baseVersion) {
    return {
      ok: false as const,
      error: 'version_conflict',
      current: mapItem(
        item,
        (getDb()
          .prepare(`SELECT * FROM subs WHERE team_id = ? AND item_key = ?`)
          .all(teamId, key) as SubRow[]),
      ),
    };
  }
  return { ok: true as const, item };
}

export function applyIntent(
  teamId: string,
  intent: Record<string, unknown>,
  actor: ActorContext,
):
  | {
      ok: true;
      snapshot: TeamSnapshot;
      itemKey?: string;
      deferSummary?: {
        moved: string[];
        shrunk: string[];
        stuck: string[];
        extended: string[];
      };
    }
  | { ok: false; error: string; current?: unknown } {
  const team = getTeam(teamId);
  if (!team) return { ok: false, error: 'team_not_found' };

  const op = String(intent.op || '') as IntentOp;
  const db = getDb();
  const ts = now();
  touchPresence(teamId, actor);
  /** Set by `add_item` so the caller can locate the row it just created. */
  let createdItemKey: string | null = null;
  /** Set by `defer_subs` so the caller can toast counts + know which subs to Jira-sync. */
  let deferSummary:
    | {
        moved: string[];
        shrunk: string[];
        stuck: string[];
        extended: string[];
      }
    | undefined;

  if (op === 'update_jql') {
    const releaseSheet = normalizeReleaseSheetInput(intent.releaseSheet);
    if (releaseSheet === undefined) {
      db.prepare(
        `UPDATE teams SET jql = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(String(intent.jql || ''), ts, teamId);
    } else {
      db.prepare(
        `UPDATE teams SET jql = ?, release_sheet_json = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(
        String(intent.jql || ''),
        JSON.stringify(releaseSheet),
        ts,
        teamId,
      );
    }
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'team',
      targetKey: teamId,
      summary: {
        jql: intent.jql,
        releaseSheet: releaseSheet === undefined ? undefined : Boolean(releaseSheet),
      },
    });
  } else if (op === 'update_release_sheet') {
    const releaseSheet = normalizeReleaseSheetInput(
      intent.releaseSheet === undefined ? null : intent.releaseSheet,
    );
    const next = releaseSheet === undefined ? null : releaseSheet;
    const silent = Boolean(intent.silent) && Boolean(next);
    const prev = parseReleaseSheet(team.release_sheet_json);
    const contentChanged =
      releaseSheetContentKey(prev) !== releaseSheetContentKey(next);
    db.prepare(
      `UPDATE teams SET release_sheet_json = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(next), ts, teamId);
    if (!silent || contentChanged) {
      writeActivity({
        teamId,
        actor: silent
          ? {
              name: '系统',
              clientId: 'system',
              source: 'system',
              shareTokenId: actor.shareTokenId || null,
              ip: actor.ip || null,
            }
          : actor,
        op,
        targetType: 'team',
        targetKey: teamId,
        summary: {
          cleared: !next,
          silent,
          triggeredBy: silent ? actor.name : undefined,
          splitPhase: next?.splitPhase,
          showPhases: next?.showPhases,
          rowCount: next?.rows?.length || 0,
        },
      });
    }
  } else if (op === 'import') {
    const items = Array.isArray(intent.items) ? intent.items : [];
    const overwrite = Boolean(intent.overwrite);
    const quarters = Array.isArray(intent.quarters)
      ? intent.quarters.map(String)
      : [];
    if (overwrite) {
      const payloadKeys = new Set(
        items
          .map((raw) => String((raw as Record<string, unknown>).key || '').trim())
          .filter(Boolean),
      );
      // Manual items are never owned by the import, so an overwrite must leave
      // them (and their subs) alone even when they sit in the same quarter.
      const candidates = quarters.length
        ? (db
            .prepare(
              `SELECT key, jira_key, scheduled FROM items
               WHERE team_id = ? AND source = 'jira'
                 AND (quarter IN (${quarters.map(() => '?').join(',')}) OR quarter IS NULL)`,
            )
            .all(teamId, ...quarters) as Array<{
            key: string;
            jira_key: string | null;
            scheduled: number;
          }>)
        : (db
            .prepare(
              `SELECT key, jira_key, scheduled FROM items WHERE team_id = ? AND source = 'jira'`,
            )
            .all(teamId) as Array<{
            key: string;
            jira_key: string | null;
            scheduled: number;
          }>);
      // A row this JQL no longer returns is a ghost the Backlog would otherwise
      // keep forever — sweep it. But a row already scheduled onto the Gantt is
      // never swept, no matter what the JQL returns: its placement and subs are
      // local state the import can't reconstruct, so deleting it means losing
      // them for good with no way back (re-importing just creates a fresh,
      // unscheduled row under the same key).
      const stillInJql = (row: { key: string; jira_key: string | null }) =>
        payloadKeys.has(row.key) ||
        Boolean(row.jira_key && payloadKeys.has(row.jira_key));
      const doomed = candidates
        .filter((row) => !row.scheduled && !stillInJql(row))
        .map((row) => row.key);
      if (doomed.length) {
        const keyPlaceholders = doomed.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM subs WHERE team_id = ? AND item_key IN (${keyPlaceholders})`,
        ).run(teamId, ...doomed);
        db.prepare(
          `DELETE FROM item_markers WHERE team_id = ? AND item_key IN (${keyPlaceholders})`,
        ).run(teamId, ...doomed);
        db.prepare(
          `DELETE FROM items WHERE team_id = ? AND key IN (${keyPlaceholders})`,
        ).run(teamId, ...doomed);
      }
    }
    let imported = 0;
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const key = String(item.key || '');
      if (!key) continue;
      // A manual item whose Jira issue we already created shows up in the JQL
      // results under its real key — update that row instead of duplicating it.
      const existing = getItem(teamId, key) || getItemByJiraKey(teamId, key);
      if (existing && !overwrite) continue;
      const projectKey =
        (item.projectKey ? String(item.projectKey) : null) ||
        projectKeyFromJiraKey(key);
      if (existing) {
        db.prepare(
          `UPDATE items SET
            type = ?, title = ?, quarter = ?, estimate = ?,
            target_start = ?, target_end = ?, source = 'jira', jira_key = ?,
            project_key = COALESCE(?, project_key),
            updated_at = ?, version = version + 1
           WHERE team_id = ? AND key = ?`,
        ).run(
          String(item.type || 'Epic'),
          String(item.title || key),
          item.quarter ? String(item.quarter) : null,
          typeof item.estimate === 'number' ? item.estimate : null,
          item.targetStart ? String(item.targetStart) : null,
          item.targetEnd ? String(item.targetEnd) : null,
          key,
          projectKey,
          ts,
          teamId,
          existing.key,
        );
      } else {
        db.prepare(
          `INSERT INTO items (
            id, team_id, key, type, title, alias, quarter, estimate,
            target_start, target_end, scheduled, start_date, days, lane,
            expanded, source, jira_key, project_key, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, 0, 0, 'jira', ?, ?, 1, ?, ?)`,
        ).run(
          nanoid(12),
          teamId,
          key,
          String(item.type || 'Epic'),
          String(item.title || key),
          item.quarter ? String(item.quarter) : null,
          typeof item.estimate === 'number' ? item.estimate : null,
          item.targetStart ? String(item.targetStart) : null,
          item.targetEnd ? String(item.targetEnd) : null,
          key,
          projectKey,
          ts,
          ts,
        );
      }
      imported += 1;
    }
    // Only mark quarters as imported when we actually received items (or overwrite cleared them).
    // Empty imports used to poison importedQuarters and hide the Import button.
    const importedQuarters = Array.from(
      new Set([
        ...parseJsonArray(team.imported_quarters_json).filter((q) => {
          if (!quarters.includes(q)) return true;
          // keep previous imported quarter only if overwrite didn't empty it with zero items
          return !(overwrite && imported === 0);
        }),
        ...(imported > 0 ? quarters : []),
      ]),
    );
    const checkedQuarters = Array.isArray(intent.checkedQuarters)
      ? intent.checkedQuarters.map(String)
      : parseJsonArray(team.checked_quarters_json);
    db.prepare(
      `UPDATE teams SET
        checked_quarters_json = ?,
        imported_quarters_json = ?,
        version = version + 1,
        updated_at = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(checkedQuarters),
      JSON.stringify(importedQuarters),
      ts,
      teamId,
    );
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'team',
      targetKey: teamId,
      summary: { quarters, count: imported },
    });
  } else if (op === 'schedule' || op === 'move' || op === 'resize') {
    const key = String(intent.itemKey || '');
    const baseVersion = Number(intent.baseVersion);
    const check = bumpItemVersion(teamId, key, baseVersion);
    if (!check.ok) return check;
    const before = check.item;
    const lane =
      typeof intent.lane === 'number' && Number.isFinite(intent.lane)
        ? Math.floor(intent.lane)
        : null;
    db.prepare(
      `UPDATE items SET
        scheduled = 1,
        start_date = ?,
        days = ?,
        lane = COALESCE(?, lane),
        version = version + 1,
        updated_at = ?
       WHERE team_id = ? AND key = ?`,
    ).run(
      intent.start ? String(intent.start) : before.start_date,
      typeof intent.days === 'number' ? intent.days : before.days,
      lane,
      ts,
      teamId,
      key,
    );
    // Vertical reorder must shift siblings; a lone lane write leaves duplicates.
    if (lane != null && (op === 'move' || op === 'schedule')) {
      reindexScheduledLanes(teamId, key, lane, ts);
    }
    // Re-dragging an Epic onto the Gantt restores soft-cleared child tasks.
    if (op === 'schedule') {
      db.prepare(
        `UPDATE subs SET cleared = 0, updated_at = ?
         WHERE team_id = ? AND item_key = ? AND cleared = 1`,
      ).run(ts, teamId, key);
    }
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'item',
      targetKey: key,
      summary: {
        title: before.title,
        alias: before.alias,
        from: before.start_date,
        to: intent.start || before.start_date,
        days: intent.days ?? before.days,
        lane: lane ?? before.lane,
      },
    });
    // Target Start/End sync is viewer-driven (extension Options token first,
    // server JIRA_PAT fallback). Do not auto-queue here.
  } else if (op === 'unschedule') {
    const key = String(intent.itemKey || '');
    const baseVersion = Number(intent.baseVersion);
    const check = bumpItemVersion(teamId, key, baseVersion);
    if (!check.ok) return check;
    db.prepare(
      `UPDATE items SET
        scheduled = 0, start_date = NULL, days = NULL, expanded = 0,
        version = version + 1, updated_at = ?
       WHERE team_id = ? AND key = ?`,
    ).run(ts, teamId, key);
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'item',
      targetKey: key,
      summary: { title: check.item.title, alias: check.item.alias },
    });
  } else if (op === 'set_alias') {
    const key = String(intent.itemKey || intent.subId || '');
    if (intent.subId) {
      const sub = db
        .prepare(`SELECT * FROM subs WHERE team_id = ? AND id = ?`)
        .get(teamId, String(intent.subId)) as SubRow | undefined;
      if (!sub) return { ok: false, error: 'sub_not_found' };
      if (sub.version !== Number(intent.baseVersion)) {
        return { ok: false, error: 'version_conflict', current: sub };
      }
      db.prepare(
        `UPDATE subs SET alias = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(intent.alias ? String(intent.alias) : null, ts, sub.id);
      writeActivity({
        teamId,
        actor,
        op,
        targetType: 'sub',
        targetKey: sub.id,
        summary: { alias: intent.alias, title: sub.title, key: sub.jira_key },
      });
    } else {
      const check = bumpItemVersion(teamId, key, Number(intent.baseVersion));
      if (!check.ok) return check;
      db.prepare(
        `UPDATE items SET alias = ?, version = version + 1, updated_at = ?
         WHERE team_id = ? AND key = ?`,
      ).run(intent.alias ? String(intent.alias) : null, ts, teamId, key);
      writeActivity({
        teamId,
        actor,
        op,
        targetType: 'item',
        targetKey: key,
        summary: { alias: intent.alias, title: check.item.title, key },
      });
    }
  } else if (op === 'update_item') {
    const key = String(intent.itemKey || '');
    const hasTitle = intent.title !== undefined;
    const hasDesc = intent.description !== undefined;
    const nextTitle = hasTitle ? String(intent.title || '').trim() : '';
    if (hasTitle && !nextTitle) return { ok: false, error: 'title_required' };
    if (!hasTitle && !hasDesc) return { ok: false, error: 'title_required' };
    const check = bumpItemVersion(teamId, key, Number(intent.baseVersion));
    if (!check.ok) return check;
    const nextDesc = hasDesc ? clipDescription(intent.description) : undefined;
    if (hasDesc && check.item.jira_key) {
      return { ok: false, error: 'item_not_draft' };
    }
    const titleSame = !hasTitle || check.item.title === nextTitle;
    const descSame =
      nextDesc === undefined || (check.item.description || null) === nextDesc;
    if (titleSame && descSame) {
      // no-op
    } else {
      const title = hasTitle ? nextTitle : check.item.title;
      const description = hasDesc ? nextDesc : check.item.description;
      db.prepare(
        `UPDATE items SET title = ?, description = ?, version = version + 1, updated_at = ?
         WHERE team_id = ? AND key = ?`,
      ).run(title, description, ts, teamId, key);
      writeActivity({
        teamId,
        actor,
        op,
        targetType: 'item',
        targetKey: key,
        summary: { title, from: check.item.title, description: Boolean(description) },
      });
    }
  } else if (op === 'expand' || op === 'collapse') {
    // Expand/collapse is per-viewer (URL `expand=` + local UI). Accept the op
    // for older clients but do not mutate shared state or broadcast — otherwise
    // one person's fold would close another mid add-subtask.
    return { ok: true, snapshot: getTeamSnapshot(teamId)! };
  } else if (op === 'add_item') {
    const title = String(intent.title || '').trim();
    if (!title) return { ok: false, error: 'title_required' };
    const hints = buildJqlHints({
      jql: team.jql,
      modeItemType: modeItemType(teamId),
    });
    const key = generateLocalItemKey(teamId);
    const type =
      String(intent.type || '').trim() || hints.itemType || 'Epic';
    const projectKey =
      String(intent.projectKey || '').trim() || hints.projectKey || null;
    db.prepare(
      `INSERT INTO items (
        id, team_id, key, type, title, alias, quarter, estimate,
        target_start, target_end, scheduled, start_date, days, lane,
        expanded, source, jira_key, project_key, description, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, 0, 0, 'manual', NULL, ?, ?, 1, ?, ?)`,
    ).run(
      nanoid(12),
      teamId,
      key,
      type,
      title,
      intent.quarter ? String(intent.quarter) : null,
      typeof intent.estimate === 'number' ? intent.estimate : null,
      intent.targetStart ? String(intent.targetStart) : null,
      intent.targetEnd ? String(intent.targetEnd) : null,
      projectKey,
      clipDescription(intent.description),
      ts,
      ts,
    );
    createdItemKey = key;
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'item',
      targetKey: key,
      summary: { title, type, quarter: intent.quarter || null, projectKey },
    });
  } else if (op === 'delete_item') {
    const key = String(intent.itemKey || '');
    const item = getItem(teamId, key);
    if (!item) return { ok: false, error: 'item_not_found' };
    // Once a real Jira issue exists the row is no longer ours to throw away.
    if (normalizeSource(item.source) !== 'manual' || item.jira_key) {
      return { ok: false, error: 'item_has_jira' };
    }
    db.prepare(`DELETE FROM subs WHERE team_id = ? AND item_key = ?`).run(
      teamId,
      key,
    );
    db.prepare(`DELETE FROM item_markers WHERE team_id = ? AND item_key = ?`).run(
      teamId,
      key,
    );
    db.prepare(`DELETE FROM items WHERE team_id = ? AND key = ?`).run(
      teamId,
      key,
    );
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'item',
      targetKey: key,
      summary: { title: item.title, alias: item.alias },
    });
  } else if (op === 'resolve_item') {
    // Deliberately no OCC check: the Jira issue already exists at this point, so
    // a concurrent drag bumping the version must never cost us the key.
    const key = String(intent.itemKey || '');
    const jiraKey = String(intent.jiraKey || '').trim();
    if (!jiraKey) return { ok: false, error: 'jira_key_required' };
    let item = getItem(teamId, key);
    if (!item && restoreUndoneRow({ teamId, itemKey: key, jiraKey })) {
      item = getItem(teamId, key);
    }
    if (!item) return { ok: false, error: 'item_not_found' };
    const type = String(intent.type || '').trim() || item.type;
    const projectKey =
      String(intent.projectKey || '').trim() ||
      item.project_key ||
      projectKeyFromJiraKey(jiraKey);
    const unchanged =
      item.jira_key === jiraKey &&
      item.type === type &&
      item.project_key === projectKey;
    if (!unchanged) {
      // Preserve the draft title as the display alias so the gantt name stays
      // put through Agent-mode summary rewrites and later refresh_from_jira
      // overwrites of `title` (alias is never touched by that path). Only when
      // the user hasn't already set one — never clobber a manual alias.
      const alias = item.alias || item.title;
      db.prepare(
        `UPDATE items SET
          jira_key = ?, type = ?, project_key = ?, alias = ?,
          version = version + 1, updated_at = ?
         WHERE team_id = ? AND key = ?`,
      ).run(jiraKey, type, projectKey, alias, ts, teamId, key);
      writeActivity({
        teamId,
        actor,
        op,
        targetType: 'item',
        targetKey: key,
        summary: { title: item.title, alias, jiraKey, type },
      });
    }
  } else if (op === 'add_sub') {
    const itemKey = String(intent.itemKey || '');
    const item = getItem(teamId, itemKey);
    if (!item) return { ok: false, error: 'item_not_found' };
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO subs (
        id, team_id, item_key, jira_key, title, alias, owner,
        start_date, days, is_draft, cleared, created_by, description, version, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, 1, 0, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      teamId,
      itemKey,
      String(intent.title || 'Untitled'),
      intent.owner ? String(intent.owner) : null,
      intent.start ? String(intent.start) : item.start_date,
      typeof intent.days === 'number' ? intent.days : 14,
      actor.name,
      clipDescription(intent.description),
      ts,
      ts,
    );
    if (intent.owner) {
      ensureMember(teamId, String(intent.owner));
    }
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'sub',
      targetKey: id,
      summary: {
        title: intent.title,
        parent: item.alias || item.title,
        temp: true,
        owner: intent.owner || null,
      },
    });
  } else if (op === 'update_sub') {
    const subId = String(intent.subId || '');
    const sub = db
      .prepare(`SELECT * FROM subs WHERE team_id = ? AND id = ?`)
      .get(teamId, subId) as SubRow | undefined;
    if (!sub) return { ok: false, error: 'sub_not_found' };
    if (
      intent.baseVersion != null &&
      sub.version !== Number(intent.baseVersion)
    ) {
      return { ok: false, error: 'version_conflict', current: sub };
    }
    const nextTitle =
      intent.title !== undefined ? String(intent.title || '').trim() || sub.title : sub.title;
    const nextAlias =
      intent.alias !== undefined
        ? intent.alias
          ? String(intent.alias)
          : null
        : sub.alias;
    const nextOwner =
      intent.owner !== undefined
        ? intent.owner
          ? String(intent.owner).trim() || null
          : null
        : sub.owner;
    const nextStart =
      intent.start !== undefined
        ? intent.start
          ? String(intent.start)
          : null
        : sub.start_date;
    const nextDays =
      intent.days !== undefined
        ? typeof intent.days === 'number'
          ? intent.days
          : sub.days
        : sub.days;
    const nextCleared =
      intent.cleared !== undefined ? (intent.cleared ? 1 : 0) : sub.cleared;
    if (intent.description !== undefined && sub.jira_key) {
      return { ok: false, error: 'item_not_draft' };
    }
    const nextDesc =
      intent.description !== undefined
        ? clipDescription(intent.description)
        : sub.description;
    const nextResolution =
      intent.owner !== undefined
        ? nextOwner
          ? 'explicit'
          : 'unassigned'
        : sub.owner_resolution || 'legacy';
    db.prepare(
      `UPDATE subs SET
        title = ?, alias = ?, owner = ?, start_date = ?, days = ?, cleared = ?,
        description = ?, owner_resolution = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      nextTitle,
      nextAlias,
      nextOwner,
      nextStart,
      nextDays,
      nextCleared,
      nextDesc,
      nextResolution,
      ts,
      sub.id,
    );
    if (nextOwner) ensureMember(teamId, nextOwner);
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'sub',
      targetKey: sub.id,
      summary: {
        title: nextTitle,
        alias: nextAlias,
        owner: nextOwner,
        from: sub.start_date,
        to: nextStart,
        days: nextDays,
      },
    });
  } else if (op === 'delete_sub') {
    const subId = String(intent.subId || '');
    const sub = db
      .prepare(`SELECT * FROM subs WHERE team_id = ? AND id = ?`)
      .get(teamId, subId) as SubRow | undefined;
    if (!sub) return { ok: false, error: 'sub_not_found' };
    db.prepare(`DELETE FROM subs WHERE id = ?`).run(subId);
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'sub',
      targetKey: subId,
      summary: { title: sub.title },
    });
  } else if (op === 'resolve_draft') {
    // Two callers write the same mapping: the extension resolves each child the
    // moment its issue exists, and the page re-sends the batch afterwards. Like
    // `resolve_item`, a repeat must be a no-op rather than a second version bump
    // and a duplicate activity line.
    const mappings = Array.isArray(intent.mappings) ? intent.mappings : [];
    for (const raw of mappings) {
      const mapping = raw as { draftId?: string; jiraKey?: string };
      if (!mapping.draftId || !mapping.jiraKey) continue;
      const sub = db
        .prepare(`SELECT * FROM subs WHERE team_id = ? AND id = ?`)
        .get(teamId, mapping.draftId) as SubRow | undefined;
      if (!sub) {
        restoreUndoneRow({
          teamId,
          subId: mapping.draftId,
          jiraKey: mapping.jiraKey,
        });
        continue;
      }
      if (sub.jira_key === mapping.jiraKey && !sub.is_draft) continue;
      // Same alias preservation as resolve_item above.
      const alias = sub.alias || sub.title;
      db.prepare(
        `UPDATE subs SET jira_key = ?, is_draft = 0, alias = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      ).run(mapping.jiraKey, alias, ts, sub.id);
      writeActivity({
        teamId,
        actor,
        op,
        targetType: 'sub',
        targetKey: sub.id,
        summary: { title: sub.title, alias, jiraKey: mapping.jiraKey },
      });
    }
  } else if (op === 'cleanup') {
    const expiredKeys = Array.isArray(intent.itemKeys)
      ? intent.itemKeys.map(String)
      : [];
    const expiredSubIds = Array.isArray(intent.subIds)
      ? intent.subIds.map(String)
      : [];
    for (const key of expiredKeys) {
      db.prepare(
        `UPDATE items SET
          scheduled = 0, start_date = NULL, days = NULL, expanded = 0,
          version = version + 1, updated_at = ?
         WHERE team_id = ? AND key = ?`,
      ).run(ts, teamId, key);
    }
    for (const subId of expiredSubIds) {
      db.prepare(
        `UPDATE subs SET cleared = 1, version = version + 1, updated_at = ?
         WHERE team_id = ? AND id = ?`,
      ).run(ts, teamId, subId);
    }
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'team',
      targetKey: teamId,
      summary: { count: expiredKeys.length + expiredSubIds.length },
    });
  } else if (op === 'add_member') {
    ensureMember(teamId, String(intent.name || ''), String(intent.avatarColor || ''));
  } else if (op === 'update_member') {
    const memberId = String(intent.memberId || '');
    const nextName = String(intent.name || '').trim();
    if (!nextName) return { ok: false, error: 'name_required' };
    const member = db
      .prepare(`SELECT * FROM members WHERE team_id = ? AND id = ?`)
      .get(teamId, memberId) as MemberRow | undefined;
    if (!member) return { ok: false, error: 'member_not_found' };
    if (member.name === nextName) {
      // no-op
    } else {
      const clash = db
        .prepare(`SELECT id FROM members WHERE team_id = ? AND name = ? AND id != ?`)
        .get(teamId, nextName, memberId);
      if (clash) return { ok: false, error: 'member_name_taken' };
      db.prepare(`UPDATE members SET name = ? WHERE id = ?`).run(nextName, memberId);
      // Owner is stored as the display name string — rename must cascade.
      db.prepare(
        `UPDATE subs SET owner = ?, version = version + 1, updated_at = ?
         WHERE team_id = ? AND owner = ?`,
      ).run(nextName, ts, teamId, member.name);
      const teamRow = getTeam(teamId);
      if (teamRow) {
        const nextMap = migrateAssigneeMapKey(
          parseAssigneeMap(teamRow.assignee_map_json),
          member.name,
          nextName,
        );
        db.prepare(
          `UPDATE teams SET assignee_map_json = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
        ).run(JSON.stringify(nextMap), ts, teamId);
      }
      writeActivity({
        teamId,
        actor,
        op,
        targetType: 'member',
        targetKey: memberId,
        summary: { from: member.name, to: nextName },
      });
    }
  } else if (op === 'remove_member') {
    db.prepare(`DELETE FROM members WHERE team_id = ? AND id = ?`).run(
      teamId,
      String(intent.memberId || ''),
    );
  } else if (op === 'add_marker') {
    const itemKey = String(intent.itemKey || '');
    const item = getItem(teamId, itemKey);
    if (!item) return { ok: false, error: 'item_not_found' };
    const kind = String(intent.kind || '') as MarkerKind;
    if (kind !== 'phase' && kind !== 'dep') {
      return { ok: false, error: 'invalid_marker_kind' };
    }
    const phaseKindRaw = intent.phaseKind
      ? (String(intent.phaseKind) as PhaseKind)
      : null;
    const label = String(intent.label || '').trim();
    const date =
      intent.date === null || intent.date === undefined || intent.date === ''
        ? null
        : String(intent.date);
    const jiraKey = intent.jiraKey ? String(intent.jiraKey).trim() || null : null;
    const etaSourceRaw = intent.etaSource
      ? (String(intent.etaSource) as EtaSource)
      : null;
    if (kind === 'phase') {
      if (!date) return { ok: false, error: 'phase_date_required' };
      if (
        !phaseKindRaw ||
        !['design', 'stage', 'production', 'custom'].includes(phaseKindRaw)
      ) {
        return { ok: false, error: 'phase_kind_required' };
      }
      if (phaseKindRaw === 'custom' && !label) {
        return { ok: false, error: 'label_required' };
      }
    } else if (!label) {
      return { ok: false, error: 'label_required' };
    }
    const phaseKind = kind === 'phase' ? phaseKindRaw : null;
    const resolvedLabel =
      kind === 'phase' && phaseKind !== 'custom'
        ? label ||
          ({ design: 'Design', stage: 'Stage', production: 'Production' } as const)[
            phaseKind as 'design' | 'stage' | 'production'
          ]
        : label;
    const etaSource =
      kind === 'dep' && date
        ? etaSourceRaw === 'jira' || etaSourceRaw === 'manual'
          ? etaSourceRaw
          : 'manual'
        : null;
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO item_markers (
        id, team_id, item_key, kind, phase_kind, label, date, jira_key, eta_source,
        jira_status, jira_target_end, jira_fetched_at,
        created_by, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 1, ?, ?)`,
    ).run(
      id,
      teamId,
      itemKey,
      kind,
      phaseKind,
      resolvedLabel,
      date,
      kind === 'dep' ? jiraKey : null,
      etaSource,
      actor.name,
      ts,
      ts,
    );
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'marker',
      targetKey: id,
      summary: {
        kind,
        label: resolvedLabel,
        date,
        jiraKey,
        parent: item.alias || item.title,
      },
    });
  } else if (op === 'update_marker') {
    const markerId = String(intent.markerId || '');
    const marker = db
      .prepare(`SELECT * FROM item_markers WHERE team_id = ? AND id = ?`)
      .get(teamId, markerId) as MarkerRow | undefined;
    if (!marker) return { ok: false, error: 'marker_not_found' };
    if (
      intent.baseVersion != null &&
      marker.version !== Number(intent.baseVersion)
    ) {
      return { ok: false, error: 'version_conflict', current: mapMarker(marker) };
    }
    const nextLabel =
      intent.label !== undefined
        ? String(intent.label || '').trim() || marker.label
        : marker.label;
    if (marker.kind === 'phase' && marker.phase_kind === 'custom' && !nextLabel) {
      return { ok: false, error: 'label_required' };
    }
    let nextDate = marker.date;
    let etaSet = false;
    if (intent.date !== undefined) {
      if (intent.date === null || intent.date === '') {
        if (marker.kind === 'phase') {
          return { ok: false, error: 'phase_date_required' };
        }
        nextDate = null;
      } else {
        nextDate = String(intent.date);
        etaSet = marker.kind === 'dep';
      }
    }
    const nextJiraKey =
      intent.jiraKey !== undefined
        ? intent.jiraKey
          ? String(intent.jiraKey).trim() || null
          : null
        : marker.jira_key;
    let nextEtaSource = marker.eta_source;
    if (marker.kind === 'dep') {
      if (!nextDate) nextEtaSource = null;
      else if (intent.etaSource === 'jira' || intent.etaSource === 'manual') {
        nextEtaSource = intent.etaSource;
      } else if (!nextEtaSource) {
        nextEtaSource = 'manual';
      }
    } else {
      nextEtaSource = null;
    }
    const cacheTouched =
      intent.jiraStatus !== undefined || intent.jiraTargetEnd !== undefined;
    const nextJiraStatus =
      intent.jiraStatus !== undefined
        ? String(intent.jiraStatus || '').trim() || null
        : marker.jira_status;
    const nextJiraTargetEnd =
      intent.jiraTargetEnd !== undefined
        ? isoDateOrNull(intent.jiraTargetEnd)
        : marker.jira_target_end;
    const nextJiraFetchedAt = cacheTouched ? ts : marker.jira_fetched_at;
    db.prepare(
      `UPDATE item_markers SET
        label = ?, date = ?, jira_key = ?, eta_source = ?,
        jira_status = ?, jira_target_end = ?, jira_fetched_at = ?,
        version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      nextLabel,
      nextDate,
      nextJiraKey,
      nextEtaSource,
      nextJiraStatus,
      nextJiraTargetEnd,
      nextJiraFetchedAt,
      ts,
      marker.id,
    );
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'marker',
      targetKey: marker.id,
      summary: {
        kind: marker.kind,
        label: nextLabel,
        date: nextDate,
        jiraKey: nextJiraKey,
        parent: marker.item_key,
        etaSet,
      },
    });
  } else if (op === 'delete_marker') {
    const markerId = String(intent.markerId || '');
    const marker = db
      .prepare(`SELECT * FROM item_markers WHERE team_id = ? AND id = ?`)
      .get(teamId, markerId) as MarkerRow | undefined;
    if (!marker) return { ok: false, error: 'marker_not_found' };
    db.prepare(`DELETE FROM item_markers WHERE id = ?`).run(markerId);
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'marker',
      targetKey: markerId,
      summary: {
        kind: marker.kind,
        label: marker.label,
        date: marker.date,
        jiraKey: marker.jira_key,
        parent: marker.item_key,
      },
    });
  } else if (op === 'lock') {
    const targetType = String(intent.targetType || 'item');
    const targetKey = String(intent.targetKey || '');
    db.prepare(
      `INSERT INTO soft_locks (
        team_id, target_type, target_key, actor_name, actor_client_id, locked_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, target_type, target_key) DO UPDATE SET
        actor_name = excluded.actor_name,
        actor_client_id = excluded.actor_client_id,
        locked_at = excluded.locked_at,
        expires_at = excluded.expires_at`,
    ).run(
      teamId,
      targetType,
      targetKey,
      actor.name,
      actor.clientId,
      ts,
      ts + config.softLockTtlMs,
    );
    emitTeamEvent(
      'lock',
      {
        teamId,
        targetType,
        targetKey,
        actorName: actor.name,
        actorClientId: actor.clientId,
        expiresAt: ts + config.softLockTtlMs,
      },
      teamId,
    );
  } else if (op === 'unlock') {
    db.prepare(
      `DELETE FROM soft_locks
       WHERE team_id = ? AND target_type = ? AND target_key = ? AND actor_client_id = ?`,
    ).run(
      teamId,
      String(intent.targetType || 'item'),
      String(intent.targetKey || ''),
      actor.clientId,
    );
    emitTeamEvent(
      'unlock',
      {
        teamId,
        targetType: intent.targetType,
        targetKey: intent.targetKey,
        actorClientId: actor.clientId,
      },
      teamId,
    );
  } else if (op === 'set_quarters') {
    db.prepare(
      `UPDATE teams SET checked_quarters_json = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(intent.checkedQuarters || []), ts, teamId);
  } else if (op === 'update_create_jira_prompt') {
    const prompt = String(intent.prompt || '');
    db.prepare(
      `UPDATE teams SET create_jira_prompt = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(prompt, ts, teamId);
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'team',
      targetKey: teamId,
      summary: { length: prompt.trim().length },
    });
  } else if (op === 'update_assignee_map') {
    const nextMap = normalizeAssigneeMap(intent.assigneeMap);
    db.prepare(
      `UPDATE teams SET assignee_map_json = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(nextMap), ts, teamId);
    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'team',
      targetKey: teamId,
      summary: { count: Object.keys(nextMap).length },
    });
  } else if (op === 'merge_people') {
    const fromName = String(intent.fromName || '').trim();
    const toName = String(intent.toName || '').trim();
    if (!fromName || !toName) {
      return { ok: false, error: 'merge_names_required' };
    }
    if (fromName.toLowerCase() === toName.toLowerCase()) {
      return { ok: false, error: 'merge_same_name' };
    }
    if (!looksFullName(toName)) {
      return { ok: false, error: 'merge_target_not_full_name' };
    }

    // Cascade identity strings on subs (Owner + createdBy); match case-insensitively.
    db.prepare(
      `UPDATE subs SET owner = ?, version = version + 1, updated_at = ?
       WHERE team_id = ? AND lower(owner) = lower(?)`,
    ).run(toName, ts, teamId, fromName);
    db.prepare(
      `UPDATE subs SET created_by = ?, version = version + 1, updated_at = ?
       WHERE team_id = ? AND lower(created_by) = lower(?)`,
    ).run(toName, ts, teamId, fromName);

    const fromMember = db
      .prepare(
        `SELECT * FROM members WHERE team_id = ? AND lower(name) = lower(?)`,
      )
      .get(teamId, fromName) as MemberRow | undefined;
    const toMember = db
      .prepare(
        `SELECT * FROM members WHERE team_id = ? AND lower(name) = lower(?)`,
      )
      .get(teamId, toName) as MemberRow | undefined;

    if (fromMember && toMember) {
      // Prefer the canonical full-name member; drop the short-name duplicate.
      db.prepare(`DELETE FROM members WHERE id = ?`).run(fromMember.id);
    } else if (fromMember && !toMember) {
      db.prepare(`UPDATE members SET name = ? WHERE id = ?`).run(
        toName,
        fromMember.id,
      );
    } else if (!fromMember && !toMember) {
      // Creators-only identity: ensure the canonical name exists for pickers.
      ensureMember(teamId, toName);
    }

    const teamRow = getTeam(teamId);
    if (teamRow) {
      const nextMap = mergeAssigneeMapIdentities(
        parseAssigneeMap(teamRow.assignee_map_json),
        fromName,
        toName,
      );
      db.prepare(
        `UPDATE teams SET assignee_map_json = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(nextMap), ts, teamId);
    }

    writeActivity({
      teamId,
      actor,
      op,
      targetType: 'member',
      targetKey: toMember?.id || fromMember?.id || toName,
      summary: { from: fromName, to: toName },
    });
  } else if (op === 'refresh_from_jira') {
    const ttlSkip = applyRefreshFromJira(teamId, team, intent, actor, ts);
    if (ttlSkip) {
      return { ok: true, snapshot: getTeamSnapshot(teamId)! };
    }
  } else if (op === 'defer_subs') {
    // "其余延至下周": move each sub so it starts on `targetStart` (next Monday).
    // Length stays when the Epic still has room; otherwise shrink down to
    // Original Estimate man-days (default 3). Callers that cannot fit even
    // that minimum pass `extendEpics` after the user confirms stretching the
    // parent Epic Target End.
    const subIds = Array.isArray(intent.subIds) ? intent.subIds.map(String) : [];
    const targetStart = isoDateOrNull(intent.targetStart);
    if (!targetStart) return { ok: false, error: 'target_start_required' };
    const extended: string[] = [];
    const extendRaw = Array.isArray(intent.extendEpics) ? intent.extendEpics : [];
    for (const row of extendRaw) {
      if (!row || typeof row !== 'object') continue;
      const ext = row as Record<string, unknown>;
      const itemKey = String(ext.itemKey || '').trim();
      const end = isoDateOrNull(ext.end);
      if (!itemKey || !end) continue;
      const item = getItem(teamId, itemKey);
      if (!item || !item.start_date || !item.days) continue;
      const currentEnd = addDaysIso(item.start_date, item.days - 1);
      if (end <= currentEnd) continue;
      const nextDays = daysBetweenIso(item.start_date, end);
      db.prepare(
        `UPDATE items SET days = ?, target_end = ?, version = version + 1, updated_at = ?
         WHERE team_id = ? AND key = ?`,
      ).run(nextDays, end, ts, teamId, itemKey);
      extended.push(itemKey);
    }
    const moved: string[] = [];
    const shrunk: string[] = [];
    const stuck: string[] = [];
    for (const subId of subIds) {
      const sub = db
        .prepare(`SELECT * FROM subs WHERE team_id = ? AND id = ?`)
        .get(teamId, subId) as SubRow | undefined;
      if (!sub || sub.cleared || !sub.start_date || !sub.days) continue;
      const item = getItem(teamId, sub.item_key);
      if (!item || !item.start_date || !item.days) continue;
      const plan = planDeferToTarget({
        subStart: sub.start_date,
        subDays: sub.days,
        epicStart: item.start_date,
        epicDays: item.days,
        targetStart,
        originalEstimateDays: sub.original_estimate_days,
      });
      if (
        plan.fit === 'noop' ||
        plan.fit === 'needs-extend' ||
        !plan.nextStart ||
        !plan.nextDays
      ) {
        stuck.push(subId);
        continue;
      }
      db.prepare(
        `UPDATE subs SET start_date = ?, days = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(plan.nextStart, plan.nextDays, ts, subId);
      moved.push(subId);
      if (plan.fit === 'shrink') shrunk.push(subId);
    }
    deferSummary = { moved, shrunk, stuck, extended };
    if (moved.length || extended.length) {
      writeActivity({
        teamId,
        actor,
        op,
        targetType: 'sub',
        targetKey: subIds[0] || extended[0] || '',
        summary: {
          movedCount: moved.length,
          shrunkCount: shrunk.length,
          stuckCount: stuck.length,
          extendedCount: extended.length,
          targetStart,
        },
      });
    }
  } else {
    return { ok: false, error: `unsupported_op:${op}` };
  }

  const snapshot = getTeamSnapshot(teamId)!;
  emitTeamEvent('snapshot', snapshot, teamId);
  emitTeamEvent('intent', publicIntentEvent(op, intent, actor), teamId);
  return {
    ok: true,
    snapshot,
    ...(createdItemKey ? { itemKey: createdItemKey } : {}),
    ...(deferSummary ? { deferSummary } : {}),
  };
}

const AV_COLORS = [
  '#5B8DEF',
  '#E4708A',
  '#57A773',
  '#B08BD9',
  '#E0A458',
  '#4FA3A5',
  '#C97B5A',
];

function ensureMember(teamId: string, name: string, color = ''): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM members WHERE team_id = ? AND name = ?`)
    .get(teamId, trimmed);
  if (existing) return;
  db.prepare(
    `INSERT INTO members (id, team_id, name, avatar_color, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    nanoid(10),
    teamId,
    trimmed,
    color || AV_COLORS[Math.floor(Math.random() * AV_COLORS.length)],
    now(),
  );
}

/** Focus items currently on Gantt for a team (for extension sync). */
export function listFocusItems(teamId: string) {
  const snapshot = getTeamSnapshot(teamId);
  if (!snapshot) return [];
  return snapshot.items
    .filter((item) => item.scheduled)
    .map((item) => {
      const jiraKey =
        item.jiraKey || (item.source === 'jira' ? item.key : null);
      return {
        key: item.key,
        jiraKey,
        source: item.source,
        isDraft: !jiraKey,
        type: item.type,
        title: item.title,
        alias: item.alias,
        displayName: item.alias || truncateTitle(item.title, item.key),
        quarter: item.quarter,
        targetStart: item.targetStart,
        targetEnd: item.targetEnd,
        start: item.start,
        days: item.days,
        description: [
          item.description,
          ...item.subs
            .filter((s) => !s.cleared && s.description)
            .map((s) => s.description),
        ]
          .filter(Boolean)
          .join('\n') || null,
        // The synthetic LOCAL-xxx key never appears in a message, so it would
        // only pollute the generated watch rules. Description stays out of keywords.
        keywords: [
          jiraKey,
          item.alias,
          ...item.subs
            .filter((s) => !s.cleared)
            .map((s) => s.alias || s.title)
            .filter(Boolean),
        ].filter(Boolean),
        hasAlias: Boolean(item.alias),
        subCount: item.subs.filter((s) => !s.cleared).length,
        priorityHints: {
          hasAlias: Boolean(item.alias),
          subActivity: item.subs.some((s) => !s.cleared),
          intersectsCurrentMonth: intersectsCurrentMonth(item.start, item.days),
        },
      };
    });
}

function truncateTitle(title: string, key: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 12) return cleaned || key;
  return `${cleaned.slice(0, 10)}…`;
}

function intersectsCurrentMonth(
  start: string | null | undefined,
  days: number | null | undefined,
): boolean {
  if (!start || !days) return false;
  const s = new Date(start);
  const e = new Date(s.getTime() + days * 86_400_000);
  const nowDate = new Date();
  const mStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);
  const mEnd = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0);
  return s <= mEnd && e >= mStart;
}

export interface ImportTasksResult {
  added: number;
  skipped: number;
  byEpic: Record<string, { added: number; skipped: number }>;
  snapshot: TeamSnapshot;
}

function normalizeRemoteTasks(raw: unknown): RemoteTask[] {
  if (!Array.isArray(raw)) return [];
  const out: RemoteTask[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const key = String(r.key || '').trim();
    const epicKey = String(r.epicKey || '').trim();
    if (!key || !epicKey) continue;
    out.push({
      key,
      summary: String(r.summary || key),
      epicKey,
      targetStart: r.targetStart ? String(r.targetStart) : null,
      targetEnd: r.targetEnd ? String(r.targetEnd) : null,
      assignee: r.assignee ? String(r.assignee) : null,
      originalEstimateDays: coerceOriginalEstimateDays(
        r.originalEstimateDays ?? r.timeoriginalestimate,
      ),
    });
  }
  return out;
}

/**
 * Insert pre-fetched Jira Tasks (from extension Options token search) into
 * subs, deduped by jira_key. Used by the primary import-tasks path.
 */
export function importRemoteTasks(
  teamId: string,
  actor: ActorContext,
  remoteInput: unknown,
):
  | { ok: true; result: ImportTasksResult }
  | { ok: false; error: string; status?: number } {
  const team = getTeam(teamId);
  if (!team) return { ok: false, error: 'team_not_found', status: 404 };

  const remote = normalizeRemoteTasks(remoteInput);
  const db = getDb();
  const parents = db
    .prepare(
      `SELECT * FROM items
       WHERE team_id = ? AND scheduled = 1 AND jira_key IS NOT NULL AND jira_key != ''`,
    )
    .all(teamId) as ItemRow[];
  const parentByJira = new Map(parents.map((p) => [p.jira_key!, p]));

  const existing = new Set(
    (
      db
        .prepare(
          `SELECT jira_key FROM subs
           WHERE team_id = ? AND jira_key IS NOT NULL AND jira_key != ''`,
        )
        .all(teamId) as Array<{ jira_key: string }>
    ).map((r) => r.jira_key),
  );

  let added = 0;
  let skipped = 0;
  const byEpic: Record<string, { added: number; skipped: number }> = {};
  const ts = now();

  for (const task of remote) {
    const bucket = byEpic[task.epicKey] || { added: 0, skipped: 0 };
    byEpic[task.epicKey] = bucket;
    if (existing.has(task.key)) {
      skipped++;
      bucket.skipped++;
      continue;
    }
    const parent = parentByJira.get(task.epicKey);
    if (!parent) {
      skipped++;
      bucket.skipped++;
      continue;
    }

    const parentStart = parent.start_date;
    const parentDays =
      typeof parent.days === 'number' && parent.days > 0 ? parent.days : 14;
    if (!parentStart) {
      skipped++;
      bucket.skipped++;
      continue;
    }
    const span = importedTaskSpan(
      { start: parentStart, days: parentDays },
      task.targetStart,
      task.targetEnd,
    );
    const start = span.start;
    const days = span.days;

    const id = nanoid(12);
    const owner = task.assignee || null;
    const mirroredStart = task.targetStart || start;
    const mirroredEnd = task.targetEnd || addDaysIso(start, days - 1);
    db.prepare(
      `INSERT INTO subs (
        id, team_id, item_key, jira_key, title, alias, owner,
        start_date, days, target_start, target_end, is_draft, cleared, created_by,
        original_estimate_days, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      teamId,
      parent.key,
      task.key,
      task.summary,
      owner,
      start,
      days,
      mirroredStart,
      mirroredEnd,
      actor.name,
      task.originalEstimateDays ?? null,
      ts,
      ts,
    );
    if (owner) ensureMember(teamId, owner);
    existing.add(task.key);
    added++;
    bucket.added++;
  }

  writeActivity({
    teamId,
    actor,
    op: 'import_tasks',
    targetType: 'team',
    targetKey: teamId,
    summary: { added, skipped, byEpic },
  });

  const snapshot = getTeamSnapshot(teamId)!;
  emitTeamEvent('snapshot', snapshot, teamId);
  emitTeamEvent('intent', publicIntentEvent('import_tasks', {}, actor), teamId);

  return {
    ok: true,
    result: { added, skipped, byEpic, snapshot },
  };
}

/**
 * Server-side Jira search + import (fallback when body has no tasks and
 * JIRA_PAT is configured). Prefer extension-fetched tasks via importRemoteTasks.
 */
export async function importTasksFromJira(
  teamId: string,
  actor: ActorContext,
): Promise<
  | { ok: true; result: ImportTasksResult }
  | { ok: false; error: string; status?: number }
> {
  if (!config.jira.enabled) {
    return { ok: false, error: 'jira_not_configured', status: 501 };
  }
  const team = getTeam(teamId);
  if (!team) return { ok: false, error: 'team_not_found', status: 404 };

  const db = getDb();
  const parents = db
    .prepare(
      `SELECT * FROM items
       WHERE team_id = ? AND scheduled = 1 AND jira_key IS NOT NULL AND jira_key != ''`,
    )
    .all(teamId) as ItemRow[];

  if (!parents.length) {
    const snapshot = getTeamSnapshot(teamId)!;
    return {
      ok: true,
      result: { added: 0, skipped: 0, byEpic: {}, snapshot },
    };
  }

  const hints = buildJqlHints({
    jql: team.jql,
    modeItemType: modeItemType(teamId),
  });
  const epicKeys = parents.map((p) => p.jira_key!).filter(Boolean);

  let remote: RemoteTask[];
  try {
    remote = await jiraSearchChildTasks(epicKeys, hints);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `jira_search_failed:${msg}`, status: 502 };
  }

  return importRemoteTasks(teamId, actor, remote);
}

export const JIRA_REFRESH_TTL_MS = 10 * 60 * 1000;

function isoDateOrNull(raw: unknown): string | null {
  const value = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function jiraStatusName(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'object' && 'name' in raw) {
    const name = String((raw as { name?: unknown }).name || '').trim();
    return name || null;
  }
  return null;
}

/**
 * Batch Jira → Roadmap mirror. Returns true when the call was skipped by TTL
 * (caller should not write activity / should not treat it as a mutation).
 *
 * Schedule relocation uses last-mirrored `target_*` as the 3-way base: if the
 * Gantt span already diverges (someone resized without confirming to Jira),
 * keep local dates and still apply status/summary. Otherwise Jira Target wins.
 */
function applyRefreshFromJira(
  teamId: string,
  team: TeamRow,
  intent: Record<string, unknown>,
  actor: ActorContext,
  ts: number,
): boolean {
  const db = getDb();
  const ignoreTtl = Boolean(intent.ignoreTtl);
  if (
    !ignoreTtl &&
    team.jira_refreshed_at &&
    ts - Number(team.jira_refreshed_at) < JIRA_REFRESH_TTL_MS
  ) {
    return true;
  }
  db.prepare(
    `UPDATE teams SET jira_refreshed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(ts, ts, teamId);

  const map = parseAssigneeMap(team.assignee_map_json);
  const issues = Array.isArray(intent.issues) ? intent.issues : [];
  let changed = 0;

  for (const raw of issues) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const fields =
      row.fields && typeof row.fields === 'object'
        ? (row.fields as Record<string, unknown>)
        : row;
    const key = String(row.key || fields.key || '').trim();
    if (!key) continue;
    const fetchedAt = Number(row.fetchedAt || fields.fetchedAt) || ts;
    const summary =
      fields.summary !== undefined ? String(fields.summary || '').trim() : undefined;
    const description =
      fields.description !== undefined
        ? clipDescription(fields.description)
        : undefined;
    const targetStart =
      fields.targetStart !== undefined ? isoDateOrNull(fields.targetStart) : undefined;
    const targetEnd =
      fields.targetEnd !== undefined ? isoDateOrNull(fields.targetEnd) : undefined;
    const assignee =
      fields.assignee !== undefined
        ? String(fields.assignee || '').trim() || null
        : undefined;
    const status = jiraStatusName(fields.status);
    const originalEstimateDays =
      fields.originalEstimateDays !== undefined
        ? coerceOriginalEstimateDays(fields.originalEstimateDays)
        : fields.timeoriginalestimate !== undefined
          ? originalEstimateFromJiraFields(fields)
          : undefined;

    const item = db
      .prepare(`SELECT * FROM items WHERE team_id = ? AND jira_key = ?`)
      .get(teamId, key) as ItemRow | undefined;
    const sub = item
      ? undefined
      : (db
          .prepare(`SELECT * FROM subs WHERE team_id = ? AND jira_key = ?`)
          .get(teamId, key) as SubRow | undefined);

    if (item) {
      if (item.updated_at > fetchedAt) continue;
      const nextTitle = summary || item.title;
      const nextDesc =
        description !== undefined ? description : item.description;
      const dirty = scheduleDivergesFromMirroredTarget({
        start: item.start_date,
        days: item.days,
        targetStart: item.target_start,
        targetEnd: item.target_end,
      });
      const nextTStart = dirty
        ? item.target_start
        : targetStart !== undefined
          ? targetStart
          : item.target_start;
      const nextTEnd = dirty
        ? item.target_end
        : targetEnd !== undefined
          ? targetEnd
          : item.target_end;
      const nextStatus = status !== undefined ? status : item.status;
      let nextStart = item.start_date;
      let nextDays = item.days;
      if (
        !dirty &&
        item.scheduled &&
        (targetStart !== undefined || targetEnd !== undefined)
      ) {
        if (nextTStart && nextTEnd) {
          nextStart = nextTStart;
          nextDays = daysBetweenIso(nextTStart, nextTEnd);
        } else if (nextTStart) {
          nextStart = nextTStart;
        } else if (nextTEnd && item.start_date) {
          nextDays = daysBetweenIso(item.start_date, nextTEnd);
        }
      }
      const same =
        nextTitle === item.title &&
        (nextDesc || null) === (item.description || null) &&
        (nextTStart || null) === (item.target_start || null) &&
        (nextTEnd || null) === (item.target_end || null) &&
        (nextStart || null) === (item.start_date || null) &&
        nextDays === item.days &&
        (nextStatus || null) === (item.status || null);
      if (same) continue;
      const result = db
        .prepare(
          `UPDATE items SET
            title = ?, description = ?, target_start = ?, target_end = ?,
            start_date = ?, days = ?, status = ?, version = version + 1, updated_at = ?
           WHERE team_id = ? AND key = ? AND version = ?`,
        )
        .run(
          nextTitle,
          nextDesc,
          nextTStart,
          nextTEnd,
          nextStart,
          nextDays,
          nextStatus,
          ts,
          teamId,
          item.key,
          item.version,
        );
      if (result.changes) changed += 1;
    } else if (sub) {
      if (sub.updated_at > fetchedAt) continue;
      const nextTitle = summary || sub.title;
      const nextDesc =
        description !== undefined ? description : sub.description;
      const dirty = scheduleDivergesFromMirroredTarget({
        start: sub.start_date,
        days: sub.days,
        targetStart: sub.target_start,
        targetEnd: sub.target_end,
      });
      let nextStart = sub.start_date;
      let nextDays = sub.days;
      let nextTStart = sub.target_start;
      let nextTEnd = sub.target_end;
      if (!dirty && (targetStart !== undefined || targetEnd !== undefined)) {
        const tStart = targetStart || sub.start_date;
        const tEnd =
          targetEnd ||
          (sub.start_date && sub.days
            ? addIsoDaysLocal(sub.start_date, Math.max(1, sub.days) - 1)
            : null);
        if (tStart && tEnd) {
          nextStart = tStart;
          nextDays = daysBetweenIso(tStart, tEnd);
        } else if (tStart) {
          nextStart = tStart;
        }
        nextTStart = targetStart !== undefined ? targetStart : tStart;
        nextTEnd = targetEnd !== undefined ? targetEnd : tEnd;
      }
      let nextOwner = sub.owner;
      if (assignee) {
        if (!ownerMatchesAssignee(map, sub.owner, assignee)) {
          nextOwner = assignee;
        }
      }
      const nextStatus = status !== undefined ? status : sub.status;
      const nextEstimate =
        originalEstimateDays !== undefined
          ? originalEstimateDays
          : sub.original_estimate_days;
      const same =
        nextTitle === sub.title &&
        (nextDesc || null) === (sub.description || null) &&
        (nextStart || null) === (sub.start_date || null) &&
        nextDays === sub.days &&
        (nextTStart || null) === (sub.target_start || null) &&
        (nextTEnd || null) === (sub.target_end || null) &&
        (nextOwner || null) === (sub.owner || null) &&
        (nextStatus || null) === (sub.status || null) &&
        (nextEstimate || null) === (sub.original_estimate_days || null);
      if (same) continue;
      const result = db
        .prepare(
          `UPDATE subs SET
            title = ?, description = ?, start_date = ?, days = ?,
            target_start = ?, target_end = ?, owner = ?, status = ?,
            original_estimate_days = ?,
            version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          nextTitle,
          nextDesc,
          nextStart,
          nextDays,
          nextTStart,
          nextTEnd,
          nextOwner,
          nextStatus,
          nextEstimate,
          ts,
          sub.id,
          sub.version,
        );
      if (result.changes) {
        changed += 1;
        if (nextOwner) ensureMember(teamId, nextOwner);
      }
    }

    const deps = db
      .prepare(
        `SELECT * FROM item_markers
         WHERE team_id = ? AND kind = 'dep' AND jira_key = ?`,
      )
      .all(teamId, key) as MarkerRow[];
    for (const marker of deps) {
      const nextStatus = status !== undefined ? status : marker.jira_status;
      const nextTargetEnd =
        targetEnd !== undefined ? targetEnd : marker.jira_target_end;
      const same =
        (nextStatus || null) === (marker.jira_status || null) &&
        (nextTargetEnd || null) === (marker.jira_target_end || null);
      if (same) continue;
      // Cache only — never copy Target End onto marker.date. Skip version
      // bump so a user confirming ETA is not OCC-blocked by this refresh.
      db.prepare(
        `UPDATE item_markers SET
          jira_status = ?, jira_target_end = ?, jira_fetched_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextStatus, nextTargetEnd, fetchedAt, ts, marker.id);
      changed += 1;
    }
  }

  if (changed > 0) {
    writeActivity({
      teamId,
      actor,
      op: 'refresh_from_jira',
      targetType: 'team',
      targetKey: teamId,
      summary: { count: changed, via: 'extension' },
    });
  }
  return false;
}

function addIsoDaysLocal(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/**
 * Extension already wrote Target dates to Jira — mirror into local DB + activity.
 *
 * Also re-assert `start_date`/`days` from the dates we just pushed. Open-page
 * silent refresh can race (fetch still sees old Jira Target) and relocate the
 * bar back; without this, confirm only stamped `target_*` and left the bar
 * stuck on the stale schedule until TTL expired.
 */
export function confirmTargetSync(
  teamId: string,
  actor: ActorContext,
  input: {
    itemKey?: string;
    subId?: string;
    start: string;
    end: string;
    jiraKey?: string;
  },
):
  | { ok: true; snapshot: TeamSnapshot }
  | { ok: false; error: string; status?: number } {
  const itemKey = String(input.itemKey || '').trim();
  const subId = String(input.subId || '').trim();
  const start = String(input.start || '').trim();
  const end = String(input.end || '').trim();
  if ((!itemKey && !subId) || !start || !end) {
    return { ok: false, error: 'start_end_required', status: 400 };
  }
  if (!isoDateOrNull(start) || !isoDateOrNull(end)) {
    return { ok: false, error: 'start_end_invalid', status: 400 };
  }
  const days = daysBetweenIso(start, end);
  if (days < 1) {
    return { ok: false, error: 'start_end_invalid', status: 400 };
  }
  const db = getDb();
  const ts = now();

  if (subId) {
    const sub = db
      .prepare(`SELECT * FROM subs WHERE team_id = ? AND id = ?`)
      .get(teamId, subId) as SubRow | undefined;
    if (!sub) return { ok: false, error: 'sub_not_found', status: 404 };
    const jiraKey = sub.jira_key || String(input.jiraKey || '').trim() || null;
    if (!jiraKey) return { ok: false, error: 'jira_key_required', status: 400 };
    db.prepare(
      `UPDATE subs SET
        start_date = ?, days = ?, target_start = ?, target_end = ?,
        version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(start, days, start, end, ts, subId);
    writeActivity({
      teamId,
      actor,
      op: 'jira_sync',
      targetType: 'sub',
      targetKey: subId,
      summary: {
        title: sub.title,
        alias: sub.alias,
        jiraKey,
        start,
        end,
        via: 'extension',
      },
    });
    const snapshot = getTeamSnapshot(teamId)!;
    emitTeamEvent('snapshot', snapshot, teamId);
    return { ok: true, snapshot };
  }

  const item = db
    .prepare(`SELECT * FROM items WHERE team_id = ? AND key = ?`)
    .get(teamId, itemKey) as ItemRow | undefined;
  if (!item) return { ok: false, error: 'item_not_found', status: 404 };
  const jiraKey = item.jira_key || String(input.jiraKey || '').trim() || null;
  if (!jiraKey) return { ok: false, error: 'jira_key_required', status: 400 };

  // Keep Gantt span aligned with the Target we confirmed to Jira. Silent
  // refresh may have already overwritten start_date/days with a stale fetch.
  if (item.scheduled) {
    db.prepare(
      `UPDATE items SET
        target_start = ?, target_end = ?,
        start_date = ?, days = ?,
        version = version + 1, updated_at = ?
       WHERE team_id = ? AND key = ?`,
    ).run(start, end, start, days, ts, teamId, itemKey);
  } else {
    db.prepare(
      `UPDATE items SET target_start = ?, target_end = ?, updated_at = ?
       WHERE team_id = ? AND key = ?`,
    ).run(start, end, ts, teamId, itemKey);
  }

  writeActivity({
    teamId,
    actor,
    op: 'jira_sync',
    targetType: 'item',
    targetKey: itemKey,
    summary: {
      title: item.title,
      alias: item.alias,
      jiraKey,
      start,
      end,
      via: 'extension',
    },
  });

  const snapshot = getTeamSnapshot(teamId)!;
  emitTeamEvent('snapshot', snapshot, teamId);
  return { ok: true, snapshot };
}
