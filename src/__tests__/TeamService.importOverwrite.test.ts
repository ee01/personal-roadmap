/**
 * Overwrite-import cleanup for rows that carry no quarter.
 *
 * Real teams hit this: the quarter filter lives on the parent Initiative
 * (`portfolioChildrenOf('… "Target Delivery Quarter" in (…)')`), so every
 * imported Epic used to land with `quarter = NULL`. A quarter-scoped delete can
 * never match those rows, which left rows dropped from the JQL sitting in the
 * Backlog forever — while a blanket delete would have wiped the schedule and
 * subs of rows that are still valid.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext, TeamSnapshot } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-ovw-'));

const { applyIntent, createTeam, getTeamSnapshot } = await import(
  '../core/TeamService.js'
);

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'creator',
};

const JQL =
  `issueFunction in portfolioChildrenOf('project = INIT ` +
  `AND "Target Delivery Quarter" in (2026-Q3, 2026-Q4)') ` +
  `and issuetype = Epic and project=NOVA`;

const QUARTERS = ['2026-Q3', '2026-Q4'];

let teamId = '';

function apply(intent: Record<string, unknown>) {
  const result = applyIntent(teamId, intent, actor);
  if (!result.ok) throw new Error(`intent failed: ${result.error}`);
  return result;
}

function importItems(items: Array<Record<string, unknown>>) {
  return apply({ op: 'import', overwrite: true, quarters: QUARTERS, items });
}

function snapshot(): TeamSnapshot {
  return getTeamSnapshot(teamId)!;
}

function keysOf(snap: TeamSnapshot): string[] {
  return snap.items.map((item) => item.key).sort();
}

beforeEach(() => {
  teamId = createTeam({ name: 'Nova CA', jql: JQL, actor }).team.id;
});

describe('overwrite import with rows that have no quarter', () => {
  it('drops a row the JQL no longer returns instead of keeping it forever', () => {
    importItems([
      { key: 'NOVA-1', type: 'Epic', title: 'still in jql' },
      { key: 'NOVA-2', type: 'Epic', title: 'later dropped from jql' },
    ]);
    expect(keysOf(snapshot())).toEqual(['NOVA-1', 'NOVA-2']);

    importItems([{ key: 'NOVA-1', type: 'Epic', title: 'still in jql' }]);
    expect(keysOf(snapshot())).toEqual(['NOVA-1']);
  });

  it('keeps the schedule and subs of a row that is still in the JQL', () => {
    importItems([{ key: 'NOVA-1', type: 'Epic', title: 'scheduled epic' }]);
    const before = snapshot().items.find((i) => i.key === 'NOVA-1')!;
    apply({
      op: 'schedule',
      itemKey: 'NOVA-1',
      baseVersion: before.version,
      start: '2026-07-01',
      days: 10,
    });
    apply({ op: 'add_sub', itemKey: 'NOVA-1', title: 'child' });

    importItems([{ key: 'NOVA-1', type: 'Epic', title: 'scheduled epic' }]);

    const after = snapshot().items.find((i) => i.key === 'NOVA-1')!;
    expect(after.scheduled).toBe(true);
    expect(after.start).toBe('2026-07-01');
    expect(after.days).toBe(10);
    expect(after.subs).toHaveLength(1);
  });

  it('keeps a scheduled row even when it carries a matching quarter', () => {
    importItems([
      { key: 'NOVA-1', type: 'Epic', title: 'q3 epic', quarter: '2026-Q3' },
    ]);
    const before = snapshot().items.find((i) => i.key === 'NOVA-1')!;
    apply({
      op: 'schedule',
      itemKey: 'NOVA-1',
      baseVersion: before.version,
      start: '2026-07-01',
      days: 10,
    });

    importItems([
      { key: 'NOVA-1', type: 'Epic', title: 'q3 epic', quarter: '2026-Q3' },
    ]);
    const after = snapshot().items.find((i) => i.key === 'NOVA-1')!;
    expect(after.scheduled).toBe(true);
    expect(after.start).toBe('2026-07-01');
    expect(after.days).toBe(10);
  });

  it('never sweeps a scheduled row, even once it disappears from the JQL', () => {
    importItems([{ key: 'NOVA-1', type: 'Epic', title: 'scheduled epic' }]);
    const before = snapshot().items.find((i) => i.key === 'NOVA-1')!;
    apply({
      op: 'schedule',
      itemKey: 'NOVA-1',
      baseVersion: before.version,
      start: '2026-07-01',
      days: 10,
    });
    apply({ op: 'add_sub', itemKey: 'NOVA-1', title: 'child' });

    importItems([]);
    const after = snapshot().items.find((i) => i.key === 'NOVA-1')!;
    expect(after).toBeDefined();
    expect(after.scheduled).toBe(true);
    expect(after.subs).toHaveLength(1);
  });

  it('leaves manual items alone even though they may have no quarter', () => {
    const manual = apply({ op: 'add_item', title: 'hand made' }).itemKey!;
    importItems([{ key: 'NOVA-1', type: 'Epic', title: 'imported' }]);
    expect(keysOf(snapshot())).toEqual(['NOVA-1', manual].sort());
  });
});
