import { describe, expect, it } from 'vitest';
import type { RoadmapMarker, RoadmapItem } from '../types';
import {
  dependencyGap,
  dependencyState,
  dependencyMatches,
  dependencyGroups,
  snapDependencyNeed,
} from '../composables/dependency';
const dep = (patch: Partial<RoadmapMarker> = {}): RoadmapMarker => ({
  id: 'd',
  kind: 'dep',
  label: 'Dependency',
  createdBy: 'test',
  version: 1,
  ...patch,
});
describe('dependency risk rules', () => {
  it('distinguishes lateness, headroom, missing ETA, new Jira ETA and drift including removed target', () => {
    const late = dep({ need: '2026-08-20', date: '2026-08-25' });
    expect(dependencyGap(late)).toBe(5);
    expect(dependencyState(late)).toBe('late');
    expect(dependencyGap(dep({ need: '2026-08-25', date: '2026-08-20' }))).toBe(
      -5,
    );
    expect(dependencyState(dep())).toBe('missing');
    expect(
      dependencyState(dep({ jiraKey: 'P-1', jiraTargetEnd: '2026-08-25' })),
    ).toBe('stale');
    const drift = dep({
      date: '2026-08-25',
      jiraKey: 'P-1',
      jiraFetchedAt: 1,
      jiraTargetEnd: null,
    });
    expect(dependencyState(drift)).toBe('drift');
    expect(dependencyMatches({ ...late, ...drift }, 'drift')).toBe(true);
    for (const jiraStatus of ['Done', 'Closed', 'Resolved']) {
      expect(dependencyState({ ...late, jiraStatus })).toBe('done');
      expect(dependencyMatches({ ...late, jiraStatus }, 'late')).toBe(false);
    }
  });
  it('sorts tasks and their dependencies by risk and uses the same filters for copy and view', () => {
    const items = [
      { key: 'ok', markers: [dep({ date: '2026-08-20' })] },
      {
        key: 'risk',
        markers: [
          dep({ id: 'missing' }),
          dep({ id: 'late', need: '2026-08-20', date: '2026-08-25' }),
        ],
      },
      { key: 'empty', markers: [] },
    ] as RoadmapItem[];
    expect(dependencyGroups(items).map((g) => g.item.key)).toEqual([
      'risk',
      'ok',
    ]);
    expect(dependencyGroups(items)[0].deps.map((d) => d.id)).toEqual([
      'late',
      'missing',
    ]);
    expect(dependencyGroups(items, 'missing')[0].deps.map((d) => d.id)).toEqual(
      ['missing'],
    );
  });
  it('snaps within one day of confirmed ETA without changing ETA', () => {
    expect(snapDependencyNeed('2026-08-24', '2026-08-25')).toBeNull();
    expect(snapDependencyNeed('2026-08-26', '2026-08-25')).toBeNull();
    expect(snapDependencyNeed('2026-08-23', '2026-08-25')).toBe('2026-08-23');
    expect(snapDependencyNeed('2026-08-25', null)).toBe('2026-08-25');
  });
});
