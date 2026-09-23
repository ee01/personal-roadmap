import Sqlite from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Reproduce the pre-migration schema of a live deployment (no source /
// jira_key / project_key columns) so the ALTER TABLE path gets exercised.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'roadmap-migrate-'));
const legacy = new Sqlite(path.join(dataDir, 'roadmap.db'));
legacy.exec(`
  CREATE TABLE teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, jql TEXT NOT NULL DEFAULT '',
    checked_quarters_json TEXT NOT NULL DEFAULT '[]',
    imported_quarters_json TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE items (
    id TEXT PRIMARY KEY, team_id TEXT NOT NULL, key TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'Epic', title TEXT NOT NULL, alias TEXT,
    quarter TEXT, estimate REAL, target_start TEXT, target_end TEXT,
    scheduled INTEGER NOT NULL DEFAULT 0, start_date TEXT, days INTEGER,
    lane INTEGER NOT NULL DEFAULT 0, expanded INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(team_id, key)
  );
  INSERT INTO teams (id, name, jql, created_at, updated_at)
    VALUES ('Sp1CSuq7w70L', 'Legacy', 'project = NOVA', 1, 1);
  INSERT INTO items (id, team_id, key, type, title, quarter, created_at, updated_at)
    VALUES ('i1', 'Sp1CSuq7w70L', 'NOVA-42', 'Epic', 'Legacy row', '2026-Q3', 1, 1);
`);
legacy.close();

process.env.DATA_DIR = dataDir;
const { getDb, closeDb } = await import('../storage/Database.js');

function columns(db: Sqlite.Database): string[] {
  return (db.pragma('table_info(items)') as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function migrationIds(db: Sqlite.Database): string[] {
  return (db.prepare(`SELECT id FROM _migrations`).all() as Array<{ id: string }>)
    .map((row) => row.id)
    .sort();
}

describe('items migrations on an existing database', () => {
  // The deployed database predates the migration runner entirely, so schema.sql
  // has to create `_migrations` before anything reads from it — and it must not
  // contain an index over a column the ALTER TABLE has not added yet.
  it('bootstraps the ledger on a database that never had one', () => {
    const db = getDb();
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'`,
        )
        .get(),
    ).toEqual({ name: '_migrations' });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_jira_key'`,
        )
        .get(),
    ).toEqual({ name: 'idx_items_jira_key' });
  });

  it('adds the missing columns and backfills the legacy rows', () => {
    const db = getDb();
    expect(columns(db)).toEqual(
      expect.arrayContaining(['source', 'jira_key', 'project_key']),
    );
    expect(migrationIds(db)).toEqual([
      '001_initial',
      '002_items_manual_source',
      '003_items_jira_key_index',
      '004_items_backfill_jira_key',
      '005_subs_cleared',
      '006_item_markers',
      '007_teams_release_sheet',
      '008_teams_create_jira_prompt',
      '009_teams_assignee_map',
      '010_item_sub_description',
      '011_teams_jira_refreshed_at',
      '012_marker_jira_cache',
      '013_subs_status',
      '014_subs_original_estimate_days',
      '015_items_status',
      '016_draft_planning',
      '017_subs_target_dates',
    ]);
    const row = db
      .prepare(`SELECT source, jira_key, project_key FROM items WHERE id = 'i1'`)
      .get() as { source: string; jira_key: string; project_key: string };
    expect(row).toEqual({
      source: 'jira',
      jira_key: 'NOVA-42',
      project_key: 'NOVA',
    });
    expect(
      (
        db.pragma(`table_info(teams)`) as Array<{ name: string }>
      ).some((c) => c.name === 'release_sheet_json'),
    ).toBe(true);
    expect(
      (
        db.pragma(`table_info(teams)`) as Array<{ name: string }>
      ).some((c) => c.name === 'create_jira_prompt'),
    ).toBe(true);
    expect(
      (
        db.pragma(`table_info(subs)`) as Array<{ name: string }>
      ).map((c) => c.name),
    ).toEqual(
      expect.arrayContaining(['target_start', 'target_end', 'status']),
    );
  });

  it('is safe to re-run on an already migrated database', () => {
    closeDb();
    const db = getDb();
    expect(migrationIds(db)).toHaveLength(17);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number },
    ).toEqual({ n: 1 });
  });
});
