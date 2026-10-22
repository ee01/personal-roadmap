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

describe('dependency expectation and ETA separation', () => {
  it('preserves confirmed ETA on expectation edits and silent Jira refresh, with OCC', () => {
    const added = expectOk(apply(teamId, { op: 'add_marker', itemKey: 'NOVA-M1', kind: 'dep', label: 'Platform API', jiraKey: 'PLAT-22', date: '2026-08-25', need: '2026-08-20', etaSource: 'jira', jiraTargetStart: '2026-08-10', jiraTargetEnd: '2026-08-25', jiraStatus: 'Open' })).snapshot;
    const dep = itemOf(added, 'NOVA-M1').markers.find(m => m.jiraKey === 'PLAT-22')!;
    expect(dep.need).toBe('2026-08-20');
    expect(dep.etaAt).toBeTypeOf('number');
    expect(dep.jiraTargetStart).toBe('2026-08-10');
    let snapshot = expectOk(apply(teamId, { op: 'update_marker', markerId: dep.id, need: '2026-08-18', baseVersion: dep.version })).snapshot;
    let next = itemOf(snapshot, 'NOVA-M1').markers.find(m => m.id === dep.id)!;
    expect(next.date).toBe(dep.date);
    expect(next.etaSource).toBe('jira');
    expect(next.etaAt).toBe(dep.etaAt);
    const version = next.version;
    snapshot = expectOk(apply(teamId, { op: 'refresh_from_jira', issues: [{ key: 'PLAT-22', fetchedAt: Date.now(), fields: { targetStart: '2026-08-12', targetEnd: '2026-08-30', status: 'In Progress' } }] })).snapshot;
    next = itemOf(snapshot, 'NOVA-M1').markers.find(m => m.id === dep.id)!;
    expect(next).toMatchObject({ need: '2026-08-18', date: '2026-08-25', jiraTargetStart: '2026-08-12', jiraTargetEnd: '2026-08-30', version, etaAt: dep.etaAt });
    expect(apply(teamId, { op: 'update_marker', markerId: dep.id, need: null, baseVersion: dep.version }).ok).toBe(false);
    snapshot = expectOk(apply(teamId, { op: 'update_marker', markerId: dep.id, date: next.jiraTargetEnd, etaSource: 'jira', baseVersion: version })).snapshot;
    next = itemOf(snapshot, 'NOVA-M1').markers.find(m => m.id === dep.id)!;
    expect(next).toMatchObject({ date: '2026-08-30', need: '2026-08-18', etaSource: 'jira' });
    snapshot = expectOk(apply(teamId, { op: 'update_marker', markerId: dep.id, need: null, baseVersion: next.version })).snapshot;
    expect(itemOf(snapshot, 'NOVA-M1').markers.find(m => m.id === dep.id)!.need).toBeNull();
  });

  it('handles missing ETA, clears/normalizes expectation and validates input', () => {
    let snapshot = expectOk(apply(teamId, { op: 'add_marker', itemKey: 'NOVA-M1', kind: 'dep', label: 'No ticket', need: '2026-08-20' })).snapshot;
    let dep = itemOf(snapshot, 'NOVA-M1').markers.find(m => m.label === 'No ticket')!;
    expect(dep).toMatchObject({ date: null, need: '2026-08-20', etaAt: null, etaSource: null });
    snapshot = expectOk(apply(teamId, { op: 'update_marker', markerId: dep.id, date: '2026-08-20', etaSource: 'manual', baseVersion: dep.version })).snapshot;
    dep = itemOf(snapshot, 'NOVA-M1').markers.find(m => m.id === dep.id)!;
    expect(dep.need).toBeNull();
    expect(dep.etaAt).toBeTypeOf('number');
    expect(apply(teamId, { op: 'update_marker', markerId: dep.id, need: 'garbage', baseVersion: dep.version }).ok).toBe(false);
    snapshot = expectOk(apply(teamId, { op: 'update_marker', markerId: dep.id, date: null, baseVersion: dep.version })).snapshot;
    expect(itemOf(snapshot, 'NOVA-M1').markers.find(m => m.id === dep.id)).toMatchObject({ date: null, etaAt: null, etaSource: null });
  });
});

describe('editing dependency Jira tickets', () => {
  it('does not invalidate a ticket when only key casing changes', () => {
    const added = expectOk(apply(teamId, { op: 'add_marker', itemKey: 'NOVA-M1', kind: 'dep', label: 'Lowercase key', jiraKey: 'plat-21', date: '2026-11-05', etaSource: 'jira', jiraTargetEnd: '2026-11-05' })).snapshot;
    const dep = itemOf(added, 'NOVA-M1').markers.find(m => m.label === 'Lowercase key')!;
    const changed = expectOk(apply(teamId, { op: 'update_marker', markerId: dep.id, jiraKey: 'PLAT-21', baseVersion: dep.version })).snapshot;
    expect(itemOf(changed, 'NOVA-M1').markers.find(m => m.id === dep.id)).toMatchObject({ date: dep.date, need: null, etaSource: 'jira', jiraTargetEnd: dep.jiraTargetEnd, jiraFetchedAt: dep.jiraFetchedAt });
  });

  it('clears the old ticket mirror and Jira ETA on rebind while retaining the effective expectation', () => {
    const added = expectOk(apply(teamId, {
      op: 'add_marker', itemKey: 'NOVA-M1', kind: 'dep', label: 'Rebind ticket',
      jiraKey: 'PLAT-OLD', date: '2026-11-05', etaSource: 'jira',
      jiraStatus: 'Done', jiraTargetStart: '2026-10-20', jiraTargetEnd: '2026-11-05',
    })).snapshot;
    const dep = itemOf(added, 'NOVA-M1').markers.find(m => m.label === 'Rebind ticket')!;
    const changed = expectOk(apply(teamId, {
      op: 'update_marker', markerId: dep.id, jiraKey: 'PLAT-NEW', baseVersion: dep.version,
    })).snapshot;
    const next = itemOf(changed, 'NOVA-M1').markers.find(m => m.id === dep.id)!;
    expect(next).toMatchObject({
      jiraKey: 'PLAT-NEW', date: null, etaSource: null, etaAt: null,
      need: '2026-11-05', jiraStatus: null, jiraTargetStart: null,
      jiraTargetEnd: null, jiraFetchedAt: null, version: dep.version + 1,
    });
  });

  it('binds a manual dependency with freshly read dates, then unlinks without losing confirmed dates', () => {
    const added = expectOk(apply(teamId, {
      op: 'add_marker', itemKey: 'NOVA-M1', kind: 'dep', label: 'Bind and unlink', need: '2026-11-01',
    })).snapshot;
    const dep = itemOf(added, 'NOVA-M1').markers.find(m => m.label === 'Bind and unlink')!;
    const bound = expectOk(apply(teamId, {
      op: 'update_marker', markerId: dep.id, jiraKey: 'PLAT-10', date: '2026-11-08', etaSource: 'jira',
      jiraStatus: 'Open', jiraTargetStart: '2026-10-22', jiraTargetEnd: '2026-11-08', baseVersion: dep.version,
    })).snapshot;
    const linked = itemOf(bound, 'NOVA-M1').markers.find(m => m.id === dep.id)!;
    expect(linked).toMatchObject({ date: '2026-11-08', need: '2026-11-01', etaSource: 'jira', jiraStatus: 'Open', jiraTargetStart: '2026-10-22', jiraTargetEnd: '2026-11-08' });
    expect(linked.jiraFetchedAt).toBeTypeOf('number');
    const unbound = expectOk(apply(teamId, {
      op: 'update_marker', markerId: dep.id, jiraKey: null, baseVersion: linked.version,
    })).snapshot;
    expect(itemOf(unbound, 'NOVA-M1').markers.find(m => m.id === dep.id)).toMatchObject({
      jiraKey: null, date: linked.date, need: linked.need, etaSource: 'manual', etaAt: linked.etaAt,
      jiraStatus: null, jiraTargetStart: null, jiraTargetEnd: null, jiraFetchedAt: null,
    });
    const conflict = apply(teamId, { op: 'update_marker', markerId: dep.id, jiraKey: 'PLAT-11', baseVersion: linked.version });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toBe('version_conflict');
  });

  it('preserves a manually confirmed ETA when adding a ticket without an available target date', () => {
    const added = expectOk(apply(teamId, {
      op: 'add_marker', itemKey: 'NOVA-M1', kind: 'dep', label: 'Manual ETA with ticket', date: '2026-11-05', need: '2026-11-01', etaSource: 'manual',
    })).snapshot;
    const dep = itemOf(added, 'NOVA-M1').markers.find(m => m.label === 'Manual ETA with ticket')!;
    const changed = expectOk(apply(teamId, { op: 'update_marker', markerId: dep.id, jiraKey: 'PLAT-20', baseVersion: dep.version })).snapshot;
    expect(itemOf(changed, 'NOVA-M1').markers.find(m => m.id === dep.id)).toMatchObject({ date: dep.date, need: dep.need, etaSource: 'manual', etaAt: dep.etaAt, jiraKey: 'PLAT-20' });
  });
});
