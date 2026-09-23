import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

type Db = Database.Database;

interface Migration {
  id: string;
  up: (db: Db) => void;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/** Idempotent ALTER TABLE — schema.sql already carries the column for fresh databases. */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migrations run on every boot; each one must be safe to re-run because the
 * remote deployments already hold live data that cannot be rebuilt from schema.sql.
 */
const MIGRATIONS: Migration[] = [
  {
    id: '002_items_manual_source',
    up: (database) => {
      addColumn(database, 'items', 'source', `TEXT NOT NULL DEFAULT 'jira'`);
      addColumn(database, 'items', 'jira_key', 'TEXT');
      addColumn(database, 'items', 'project_key', 'TEXT');
    },
  },
  {
    id: '003_items_jira_key_index',
    up: (database) => {
      database.exec(
        `CREATE INDEX IF NOT EXISTS idx_items_jira_key ON items(team_id, jira_key)`,
      );
    },
  },
  {
    id: '004_items_backfill_jira_key',
    up: (database) => {
      // Every pre-existing row came from a Jira import, so its synthetic key IS the Jira key.
      database.exec(
        `UPDATE items SET jira_key = key
         WHERE source = 'jira' AND jira_key IS NULL AND instr(key, '-') > 1`,
      );
      database.exec(
        `UPDATE items SET project_key = substr(key, 1, instr(key, '-') - 1)
         WHERE source = 'jira' AND project_key IS NULL AND instr(key, '-') > 1`,
      );
    },
  },
  {
    id: '005_subs_cleared',
    up: (database) => {
      // Soft-hide expired subs from the Gantt; Backlog keeps the rows for restore.
      addColumn(database, 'subs', 'cleared', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '006_item_markers',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS item_markers (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          item_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          phase_kind TEXT,
          label TEXT NOT NULL,
          date TEXT,
          jira_key TEXT,
          eta_source TEXT,
          created_by TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_item_markers_team_item
          ON item_markers(team_id, item_key);
      `);
    },
  },
  {
    id: '007_teams_release_sheet',
    up: (database) => {
      // Team-shared release-train ruler config (url / phases / cached rows).
      addColumn(
        database,
        'teams',
        'release_sheet_json',
        `TEXT NOT NULL DEFAULT 'null'`,
      );
    },
  },
  {
    id: '008_teams_create_jira_prompt',
    up: (database) => {
      // Team-shared Create-Jira Agent prompt (visible to all collaborators).
      addColumn(
        database,
        'teams',
        'create_jira_prompt',
        `TEXT NOT NULL DEFAULT ''`,
      );
    },
  },
  {
    id: '009_teams_assignee_map',
    up: (database) => {
      // System name → Jira Firstname Lastname, shared by the whole team.
      addColumn(
        database,
        'teams',
        'assignee_map_json',
        `TEXT NOT NULL DEFAULT '{}'`,
      );
    },
  },
  {
    id: '010_item_sub_description',
    up: (database) => {
      addColumn(database, 'items', 'description', 'TEXT');
      addColumn(database, 'subs', 'description', 'TEXT');
    },
  },
  {
    id: '011_teams_jira_refreshed_at',
    up: (database) => {
      addColumn(database, 'teams', 'jira_refreshed_at', 'INTEGER');
    },
  },
  {
    id: '012_marker_jira_cache',
    up: (database) => {
      addColumn(database, 'item_markers', 'jira_status', 'TEXT');
      addColumn(database, 'item_markers', 'jira_target_end', 'TEXT');
      addColumn(database, 'item_markers', 'jira_fetched_at', 'INTEGER');
    },
  },
  {
    id: '013_subs_status',
    up: (database) => {
      // Mirrored Jira workflow status (e.g. Closed/Resolved); resource view uses
      // it to color completed tasks and exclude them from defer candidates.
      addColumn(database, 'subs', 'status', 'TEXT');
    },
  },
  {
    id: '014_subs_original_estimate_days',
    up: (database) => {
      // Mirrored Jira Original Estimate, ceiled to 8h man-days. Defer uses this
      // as the minimum bar length (default 3 when null).
      addColumn(database, 'subs', 'original_estimate_days', 'INTEGER');
    },
  },
  {
    id: '015_items_status',
    up: (database) => {
      // Mirrored Jira workflow status (e.g. Closed/Resolved); Gantt uses it to
      // color completed Epics the same way as completed Tasks.
      addColumn(database, 'items', 'status', 'TEXT');
    },
  },
  {
    id: '016_draft_planning',
    up: (database) => {
      addColumn(
        database,
        'subs',
        'owner_resolution',
        `TEXT NOT NULL DEFAULT 'legacy'`,
      );
      database.exec(`
        CREATE TABLE IF NOT EXISTS draft_planning_requests (
          team_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          result_kind TEXT NOT NULL,
          result_id TEXT,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (team_id, operation, request_id),
          FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS draft_planning_jobs (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          status TEXT NOT NULL,
          auto_commit INTEGER NOT NULL DEFAULT 1,
          configuration_version TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          endpoint_display TEXT,
          lease_until INTEGER,
          lease_generation INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          deadline_at INTEGER,
          queued_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          plan_id TEXT,
          batch_id TEXT,
          error_code TEXT,
          error_message TEXT,
          source_json TEXT,
          source_hash TEXT NOT NULL,
          options_json TEXT NOT NULL,
          usage_json TEXT,
          issues_json TEXT,
          FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_draft_jobs_team_status
          ON draft_planning_jobs(team_id, status, queued_at);
        CREATE TABLE IF NOT EXISTS draft_plans (
          id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          team_id TEXT NOT NULL,
          plan_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          source_json TEXT,
          source_hash TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          normalized_json TEXT NOT NULL,
          issues_json TEXT NOT NULL DEFAULT '[]',
          context_fingerprint TEXT NOT NULL DEFAULT '',
          committed_batch_id TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (id, revision),
          FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_draft_plans_team ON draft_plans(team_id, id);
        CREATE TABLE IF NOT EXISTS draft_batches (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          request_id TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          status TEXT NOT NULL,
          undo_until INTEGER NOT NULL,
          committed_at INTEGER NOT NULL,
          UNIQUE(team_id, plan_id),
          FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS draft_batch_rows (
          batch_id TEXT NOT NULL,
          ref TEXT NOT NULL,
          kind TEXT NOT NULL,
          item_key TEXT,
          sub_id TEXT,
          existing INTEGER NOT NULL DEFAULT 0,
          written_version INTEGER,
          handoff_state TEXT,
          snapshot_json TEXT,
          PRIMARY KEY (batch_id, ref)
        );
        CREATE TABLE IF NOT EXISTS draft_llm_usage (
          day TEXT NOT NULL,
          team_id TEXT NOT NULL DEFAULT '',
          calls INTEGER NOT NULL DEFAULT 0,
          tokens INTEGER NOT NULL DEFAULT 0,
          reserved_calls INTEGER NOT NULL DEFAULT 0,
          reserved_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, team_id)
        );
      `);
    },
  },
  {
    id: '017_subs_target_dates',
    up: (database) => {
      // Last mirrored Jira Target, so silent refresh can tell "local Gantt
      // dirty" apart from "Jira Target moved". Do not backfill from start/days:
      // that would mark unsynced local edits as already mirrored.
      addColumn(database, 'subs', 'target_start', 'TEXT');
      addColumn(database, 'subs', 'target_end', 'TEXT');
    },
  },
];

function runMigrations(database: Db): void {
  const applied = new Set(
    (
      database.prepare(`SELECT id FROM _migrations`).all() as Array<{ id: string }>
    ).map((row) => row.id),
  );
  const record = database.prepare(
    `INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES (?, ?)`,
  );
  record.run('001_initial', Date.now());
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    database.transaction(() => {
      migration.up(database);
      record.run(migration.id, Date.now());
    })();
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'roadmap.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  runMigrations(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
