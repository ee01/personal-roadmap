import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext, TeamSnapshot } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-markers-'));

const { applyIntent, createTeam, getTeamSnapshot } = await import(
  '../core/TeamService.js'
);

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'creator',
};

function apply(teamId: string, intent: Record<string, unknown>) {
  return applyIntent(teamId, intent, actor);
}

function expectOk(result: ReturnType<typeof applyIntent>) {
  if (!result.ok) throw new Error(`intent failed: ${result.error}`);
  return result;
}

function itemOf(snapshot: TeamSnapshot, key: string) {
  const item = snapshot.items.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`item ${key} missing`);
  return item;
}

let teamId = '';

beforeAll(() => {
  const snapshot = createTeam({
    name: 'Markers',
    jql: 'project = NOVA AND issuetype = Epic',
    actor,
  });
  teamId = snapshot.team.id;
  expectOk(
    apply(teamId, {
      op: 'import',
      quarters: ['2026-Q3'],
      overwrite: true,
      items: [
        {
          key: 'NOVA-M1',
          type: 'Epic',
          title: 'Marker host',
          quarter: '2026-Q3',
        },
      ],
    }),
  );
  expectOk(
    apply(teamId, {
      op: 'schedule',
      itemKey: 'NOVA-M1',
      start: '2026-08-03',
      days: 21,
      baseVersion: itemOf(getTeamSnapshot(teamId)!, 'NOVA-M1').version,
    }),
  );
});

describe('item markers', () => {
  it('adds a preset phase and a custom phase', () => {
    const after = expectOk(
      apply(teamId, {
        op: 'add_marker',
        itemKey: 'NOVA-M1',
        kind: 'phase',
        phaseKind: 'design',
        label: 'Design',
        date: '2026-08-20',
      }),
    ).snapshot;
    const design = itemOf(after, 'NOVA-M1').markers.find(
      (m) => m.phaseKind === 'design',
    )!;
    expect(design.kind).toBe('phase');
    expect(design.date).toBe('2026-08-20');

    const custom = expectOk(
      apply(teamId, {
        op: 'add_marker',
        itemKey: 'NOVA-M1',
        kind: 'phase',
        phaseKind: 'custom',
        label: 'Beta Gate',
        date: '2026-09-01',
      }),
    ).snapshot;
    expect(
      itemOf(custom, 'NOVA-M1').markers.some((m) => m.label === 'Beta Gate'),
    ).toBe(true);
  });

  it('adds a dep without ETA and later fills it', () => {
    const added = expectOk(
      apply(teamId, {
        op: 'add_marker',
        itemKey: 'NOVA-M1',
        kind: 'dep',
        label: 'Legal review copy',
        jiraKey: 'LEGAL-1',
      }),
    ).snapshot;
    const dep = itemOf(added, 'NOVA-M1').markers.find(
      (m) => m.kind === 'dep' && m.label === 'Legal review copy',
    )!;
    expect(dep.date).toBeNull();
    expect(dep.jiraKey).toBe('LEGAL-1');

    const filled = expectOk(
      apply(teamId, {
        op: 'update_marker',
        markerId: dep.id,
        date: '2026-08-25',
        etaSource: 'jira',
        baseVersion: dep.version,
      }),
    ).snapshot;
    const next = itemOf(filled, 'NOVA-M1').markers.find((m) => m.id === dep.id)!;
    expect(next.date).toBe('2026-08-25');
    expect(next.etaSource).toBe('jira');
  });

  it('stores Jira cache on a dep without changing ETA via update_marker', () => {
    const dep = itemOf(getTeamSnapshot(teamId)!, 'NOVA-M1').markers.find(
      (m) => m.jiraKey === 'LEGAL-1',
    )!;
    const cached = expectOk(
      apply(teamId, {
        op: 'update_marker',
        markerId: dep.id,
        jiraStatus: 'In Progress',
        jiraTargetEnd: '2026-08-30',
        baseVersion: dep.version,
      }),
    ).snapshot;
    const next = itemOf(cached, 'NOVA-M1').markers.find((m) => m.id === dep.id)!;
    expect(next.jiraStatus).toBe('In Progress');
    expect(next.jiraTargetEnd).toBe('2026-08-30');
    expect(next.date).toBe('2026-08-25');
  });

  it('rejects invalid phase / dep payloads and version conflicts', () => {
    expect(apply(teamId, { op: 'add_marker', itemKey: 'NOVA-M1', kind: 'phase' }).ok).toBe(
      false,
    );
    expect(
      apply(teamId, {
        op: 'add_marker',
        itemKey: 'NOVA-M1',
        kind: 'phase',
        phaseKind: 'custom',
        date: '2026-08-21',
      }).ok,
    ).toBe(false);
    expect(
      apply(teamId, { op: 'add_marker', itemKey: 'NOVA-M1', kind: 'dep' }).ok,
    ).toBe(false);

    const marker = itemOf(getTeamSnapshot(teamId)!, 'NOVA-M1').markers[0]!;
    const conflict = apply(teamId, {
      op: 'update_marker',
      markerId: marker.id,
      date: '2026-10-01',
      baseVersion: marker.version - 1,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toBe('version_conflict');
  });

  it('deletes markers and keeps them across unschedule/schedule', () => {
    const before = itemOf(getTeamSnapshot(teamId)!, 'NOVA-M1');
    const keep = before.markers[0]!;
    const doomed = before.markers.find((m) => m.label === 'Beta Gate')!;
    expectOk(apply(teamId, { op: 'delete_marker', markerId: doomed.id }));
    expect(
      itemOf(getTeamSnapshot(teamId)!, 'NOVA-M1').markers.some(
        (m) => m.id === doomed.id,
      ),
    ).toBe(false);

    const unsched = expectOk(
      apply(teamId, {
        op: 'unschedule',
        itemKey: 'NOVA-M1',
        baseVersion: itemOf(getTeamSnapshot(teamId)!, 'NOVA-M1').version,
      }),
    ).snapshot;
    expect(itemOf(unsched, 'NOVA-M1').markers.some((m) => m.id === keep.id)).toBe(
      true,
    );

    const back = expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: 'NOVA-M1',
        start: '2026-08-03',
        days: 21,
        baseVersion: itemOf(unsched, 'NOVA-M1').version,
      }),
    ).snapshot;
    expect(itemOf(back, 'NOVA-M1').markers.some((m) => m.id === keep.id)).toBe(
      true,
    );
  });
});
