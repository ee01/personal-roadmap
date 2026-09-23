import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The other half of the migration contract: a brand-new deployment gets its
// columns straight from schema.sql, and the migration runner must still record
// every id so a later boot does not try to re-apply them.
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-fresh-'));
const { getDb } = await import('../storage/Database.js');

describe('a database created from schema.sql', () => {
  it('already has the manual-item columns and a complete migration ledger', () => {
    const db = getDb();
    const columns = (
      db.pragma('table_info(items)') as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining(['source', 'jira_key', 'project_key']),
    );
    expect(
      (db.prepare(`SELECT id FROM _migrations`).all() as Array<{ id: string }>)
        .map((row) => row.id)
        .sort(),
    ).toEqual([
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
    expect(
      (db.pragma('table_info(subs)') as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual(expect.arrayContaining(['cleared', 'description', 'status', 'original_estimate_days', 'owner_resolution', 'target_start', 'target_end']));
    expect(
      (db.pragma('table_info(items)') as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual(expect.arrayContaining(['description', 'status']));
    expect(
      (db.pragma('table_info(teams)') as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        'release_sheet_json',
        'create_jira_prompt',
        'assignee_map_json',
        'jira_refreshed_at',
      ]),
    );
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'item_markers'`,
        )
        .get(),
    ).toEqual({ name: 'item_markers' });
    expect(
      (
        db.pragma('table_info(item_markers)') as Array<{ name: string }>
      ).map((row) => row.name),
    ).toEqual(
      expect.arrayContaining(['jira_status', 'jira_target_end', 'jira_fetched_at']),
    );
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_jira_key'`,
        )
        .get(),
    ).toEqual({ name: 'idx_items_jira_key' });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'draft_batches'`,
        )
        .get(),
    ).toEqual({ name: 'draft_batches' });
  });
});
