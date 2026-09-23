import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-refresh-'));

const { applyIntent, createTeam, getTeamSnapshot, listActivity, JIRA_REFRESH_TTL_MS } =
  await import('../core/TeamService.js');

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'extension',
};

function apply(teamId: string, intent: Record<string, unknown>) {
  return applyIntent(teamId, intent, actor);
}

function expectOk(result: ReturnType<typeof applyIntent>) {
  if (!result.ok) throw new Error(`intent failed: ${result.error}`);
  return result;
}

describe('refresh_from_jira', () => {
  let teamId = '';

  beforeAll(() => {
    const snapshot = createTeam({
      name: 'Refresh',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [
          {
            key: 'NOVA-100',
            type: 'Epic',
            title: 'Old title',
            quarter: '2026-Q3',
            targetStart: '2026-08-01',
            targetEnd: '2026-08-14',
          },
        ],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: 'NOVA-100',
        start: '2026-08-01',
        days: 14,
        lane: 0,
        baseVersion: getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!
          .version,
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: 'NOVA-100',
        title: 'child',
        start: '2026-08-03',
        days: 5,
        owner: 'esone',
      }),
    );
    const sub = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!.subs[0];
    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: sub.id, jiraKey: 'NOVA-101' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'update_assignee_map',
        assigneeMap: { esone: 'Esone Qiu' },
      }),
    );
  });

  it('diffs summary/description/target and relocates a scheduled bar', () => {
    const fetchedAt = Date.now() + 1000;
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-100',
            fetchedAt,
            fields: {
              summary: 'New title from Jira',
              description: 'Epic body',
              targetStart: '2026-08-04',
              targetEnd: '2026-08-20',
            },
          },
        ],
      }),
    );
    const item = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!;
    expect(item.title).toBe('New title from Jira');
    expect(item.description).toBe('Epic body');
    expect(item.targetStart).toBe('2026-08-04');
    expect(item.targetEnd).toBe('2026-08-20');
    expect(item.start).toBe('2026-08-04');
    expect(item.days).toBe(17);
    expect(item.alias).toBeNull();
    expect(
      listActivity(teamId).some((a) => a.op === 'refresh_from_jira'),
    ).toBe(true);
  });

  it('is idempotent on same values and respects TTL', () => {
    const before = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!;
    const version = before.version;
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-100',
            fetchedAt: Date.now() + 2000,
            fields: {
              summary: 'New title from Jira',
              description: 'Epic body',
              targetStart: '2026-08-04',
              targetEnd: '2026-08-20',
            },
          },
        ],
      }),
    );
    const afterTtl = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!;
    expect(afterTtl.version).toBe(version);
    expect(JIRA_REFRESH_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('applies status updates inside TTL when ignoreTtl is set', () => {
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        ignoreTtl: true,
        issues: [
          {
            key: 'NOVA-100',
            fetchedAt: Date.now() + 3000,
            fields: {
              status: 'Closed',
            },
          },
        ],
      }),
    );
    const item = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!;
    expect(item.status).toBe('Closed');
  });

  it('does not rewrite owner when mapped full name matches assignee', () => {
    const sub = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!.subs[0];
    expect(sub.owner).toBe('esone');
    // TTL will skip unless we wait — this test file's previous refresh already
    // stamped jira_refreshed_at. Direct DB poke is avoided; instead verify the
    // matcher via a fresh team below.
  });
});

describe('refresh_from_jira assignee + sub', () => {
  it('updates sub description and remaps unmatched assignee', () => {
    const snapshot = createTeam({
      name: 'Refresh2',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [{ key: 'NOVA-200', type: 'Epic', title: 'P', quarter: '2026-Q3' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: 'NOVA-200',
        title: 'old child',
        owner: 'ada',
        start: '2026-08-01',
        days: 4,
      }),
    );
    const sub = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-200')!.subs[0];
    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: sub.id, jiraKey: 'NOVA-201' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'update_assignee_map',
        assigneeMap: { ada: 'Ada Lovelace' },
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-201',
            fetchedAt: Date.now() + 1000,
            fields: {
              summary: 'new child',
              description: 'from jira',
              assignee: 'Ada Lovelace',
            },
          },
        ],
      }),
    );
    const matched = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-200')!.subs[0];
    expect(matched.title).toBe('new child');
    expect(matched.description).toBe('from jira');
    expect(matched.owner).toBe('ada');

    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-201',
            fetchedAt: Date.now() + 2000,
            fields: { assignee: 'Kevin Liu' },
          },
        ],
      }),
    );
    // TTL blocks the second refresh on this team.
    const still = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-200')!.subs[0];
    expect(still.owner).toBe('ada');
  });

  it('rewrites owner when assignee does not match the map', () => {
    const snapshot = createTeam({
      name: 'Refresh3',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [{ key: 'NOVA-300', type: 'Epic', title: 'P', quarter: '2026-Q3' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: 'NOVA-300',
        title: 'child',
        owner: 'ada',
        start: '2026-08-01',
        days: 4,
      }),
    );
    const sub = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-300')!.subs[0];
    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: sub.id, jiraKey: 'NOVA-301' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-301',
            fetchedAt: Date.now() + 1000,
            fields: { assignee: 'Kevin Liu' },
          },
        ],
      }),
    );
    const updated = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-300')!.subs[0];
    expect(updated.owner).toBe('Kevin Liu');
    expect(getTeamSnapshot(teamId)!.members.some((m) => m.name === 'Kevin Liu')).toBe(
      true,
    );
  });
});

describe('refresh_from_jira dep cache', () => {
  it('mirrors status and Target End onto dep markers without moving ETA', () => {
    const snapshot = createTeam({
      name: 'DepRefresh',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [{ key: 'NOVA-400', type: 'Epic', title: 'P', quarter: '2026-Q3' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: 'NOVA-400',
        start: '2026-08-01',
        days: 14,
        baseVersion: getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-400')!
          .version,
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'add_marker',
        itemKey: 'NOVA-400',
        kind: 'dep',
        label: 'Platform quota',
        jiraKey: 'PLAT-9',
        date: '2026-08-12',
        etaSource: 'jira',
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'PLAT-9',
            fetchedAt: Date.now() + 1000,
            fields: {
              status: 'In Progress',
              targetEnd: '2026-08-18',
            },
          },
        ],
      }),
    );
    const dep = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-400')!.markers.find(
      (m) => m.jiraKey === 'PLAT-9',
    )!;
    expect(dep.jiraStatus).toBe('In Progress');
    expect(dep.jiraTargetEnd).toBe('2026-08-18');
    expect(dep.date).toBe('2026-08-12');
    expect(dep.version).toBe(1);
  });
});

describe('refresh_from_jira sub status', () => {
  it('mirrors Jira status onto the sub and is idempotent', () => {
    const snapshot = createTeam({
      name: 'SubStatusRefresh',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [{ key: 'NOVA-500', type: 'Epic', title: 'P', quarter: '2026-Q3' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: 'NOVA-500',
        title: 'child',
        start: '2026-08-01',
        days: 4,
      }),
    );
    const sub = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-500')!.subs[0];
    expect(sub.status).toBeNull();
    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: sub.id, jiraKey: 'NOVA-501' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-501',
            fetchedAt: Date.now() + 1000,
            fields: { status: 'Resolved' },
          },
        ],
      }),
    );
    const refreshed = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-500')!.subs[0];
    expect(refreshed.status).toBe('Resolved');
    const version = refreshed.version;
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-501',
            fetchedAt: Date.now() + 2000,
            fields: { status: 'Resolved' },
          },
        ],
      }),
    );
    const same = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-500')!.subs[0];
    expect(same.version).toBe(version);
  });

  it('mirrors Original Estimate man-days onto the sub', () => {
    const snapshot = createTeam({
      name: 'SubEstimateRefresh',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [{ key: 'NOVA-600', type: 'Epic', title: 'P', quarter: '2026-Q3' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: 'NOVA-600',
        title: 'child',
        start: '2026-08-01',
        days: 8,
      }),
    );
    const sub = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-600')!.subs[0];
    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: sub.id, jiraKey: 'NOVA-601' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-601',
            fetchedAt: Date.now() + 1000,
            fields: { originalEstimateDays: 5 },
          },
        ],
      }),
    );
    const refreshed = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-600')!.subs[0];
    expect(refreshed.originalEstimateDays).toBe(5);
  });
});

describe('refresh_from_jira item status', () => {
  it('mirrors Jira status onto the Epic and is idempotent', () => {
    const snapshot = createTeam({
      name: 'ItemStatusRefresh',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [{ key: 'NOVA-700', type: 'Epic', title: 'P', quarter: '2026-Q3' }],
      }),
    );
    const before = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-700')!;
    expect(before.status ?? null).toBeNull();
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-700',
            fetchedAt: Date.now() + 1000,
            fields: { status: 'Closed' },
          },
        ],
      }),
    );
    const refreshed = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-700')!;
    expect(refreshed.status).toBe('Closed');
    const version = refreshed.version;
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-700',
            fetchedAt: Date.now() + 2000,
            fields: { status: 'Closed' },
          },
        ],
      }),
    );
    const same = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-700')!;
    expect(same.status).toBe('Closed');
    expect(same.version).toBe(version);
  });

  it('writes status even when title and Target dates are unchanged', () => {
    const snapshot = createTeam({
      name: 'ItemStatusOnlyRefresh',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [
          {
            key: 'NOVA-701',
            type: 'Epic',
            title: 'Keep me',
            quarter: '2026-Q3',
            targetStart: '2026-08-01',
            targetEnd: '2026-08-14',
          },
        ],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-701',
            fetchedAt: Date.now() + 1000,
            fields: {
              summary: 'Keep me',
              targetStart: '2026-08-01',
              targetEnd: '2026-08-14',
              status: 'Resolved',
            },
          },
        ],
      }),
    );
    const refreshed = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-701')!;
    expect(refreshed.title).toBe('Keep me');
    expect(refreshed.targetStart).toBe('2026-08-01');
    expect(refreshed.targetEnd).toBe('2026-08-14');
    expect(refreshed.status).toBe('Resolved');
  });
});

describe('refresh_from_jira keeps unsynced local schedule', () => {
  it('does not relocate a resized epic when Jira Target is still the old dates', () => {
    const snapshot = createTeam({
      name: 'KeepLocalEpic',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [
          {
            key: 'NOVA-800',
            type: 'Epic',
            title: 'Keep me',
            quarter: '2026-Q3',
            targetStart: '2026-08-01',
            targetEnd: '2026-08-14',
          },
        ],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: 'NOVA-800',
        start: '2026-08-01',
        days: 14,
        lane: 0,
        baseVersion: getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-800')!
          .version,
      }),
    );
    const scheduled = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-800')!;
    expectOk(
      apply(teamId, {
        op: 'resize',
        itemKey: 'NOVA-800',
        start: '2026-08-01',
        days: 21,
        baseVersion: scheduled.version,
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-800',
            fetchedAt: Date.now() + 1000,
            fields: {
              summary: 'Keep me from Jira',
              status: 'In Progress',
              targetStart: '2026-08-01',
              targetEnd: '2026-08-14',
            },
          },
        ],
      }),
    );
    const kept = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-800')!;
    expect(kept.start).toBe('2026-08-01');
    expect(kept.days).toBe(21);
    expect(kept.targetStart).toBe('2026-08-01');
    expect(kept.targetEnd).toBe('2026-08-14');
    expect(kept.title).toBe('Keep me from Jira');
    expect(kept.status).toBe('In Progress');
  });

  it('still relocates when local span matches last mirrored Target and Jira moved', () => {
    const snapshot = createTeam({
      name: 'ApplyJiraEpic',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [
          {
            key: 'NOVA-801',
            type: 'Epic',
            title: 'Synced',
            quarter: '2026-Q3',
            targetStart: '2026-08-01',
            targetEnd: '2026-08-14',
          },
        ],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: 'NOVA-801',
        start: '2026-08-01',
        days: 14,
        lane: 0,
        baseVersion: getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-801')!
          .version,
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-801',
            fetchedAt: Date.now() + 1000,
            fields: {
              targetStart: '2026-08-04',
              targetEnd: '2026-08-20',
            },
          },
        ],
      }),
    );
    const moved = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-801')!;
    expect(moved.start).toBe('2026-08-04');
    expect(moved.days).toBe(17);
    expect(moved.targetStart).toBe('2026-08-04');
    expect(moved.targetEnd).toBe('2026-08-20');
  });

  it('keeps a resized sub after Target has been mirrored once', () => {
    const snapshot = createTeam({
      name: 'KeepLocalSub',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [{ key: 'NOVA-802', type: 'Epic', title: 'P', quarter: '2026-Q3' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: 'NOVA-802',
        title: 'child',
        start: '2026-08-01',
        days: 4,
      }),
    );
    const draft = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-802')!.subs[0];
    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: draft.id, jiraKey: 'NOVA-803' }],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        issues: [
          {
            key: 'NOVA-803',
            fetchedAt: Date.now() + 1000,
            fields: {
              targetStart: '2026-08-01',
              targetEnd: '2026-08-04',
              status: 'Open',
            },
          },
        ],
      }),
    );
    const mirrored = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-802')!.subs[0];
    expect(mirrored.targetStart).toBe('2026-08-01');
    expect(mirrored.targetEnd).toBe('2026-08-04');
    expectOk(
      apply(teamId, {
        op: 'update_sub',
        subId: mirrored.id,
        start: '2026-08-01',
        days: 10,
        baseVersion: mirrored.version,
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'refresh_from_jira',
        ignoreTtl: true,
        issues: [
          {
            key: 'NOVA-803',
            fetchedAt: Date.now() + 2000,
            fields: {
              targetStart: '2026-08-01',
              targetEnd: '2026-08-04',
              status: 'Closed',
            },
          },
        ],
      }),
    );
    const kept = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-802')!.subs[0];
    expect(kept.start).toBe('2026-08-01');
    expect(kept.days).toBe(10);
    expect(kept.targetStart).toBe('2026-08-01');
    expect(kept.targetEnd).toBe('2026-08-04');
    expect(kept.status).toBe('Closed');
  });
});
