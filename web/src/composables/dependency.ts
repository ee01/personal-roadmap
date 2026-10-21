import type { RoadmapItem, RoadmapMarker } from '../types';
import { addD, diffD, fmtISO, today } from './useGeometry';
import { isDoneStatus } from './useRoadmapContract';

export type DependencyFilter = 'all' | 'late' | 'missing' | 'drift';
export type DependencyState =
  'late' | 'missing' | 'stale' | 'drift' | 'ok' | 'done';
export const DEP_LABEL: Record<DependencyState, string> = {
  late: '晚于期望',
  missing: '缺 ETA',
  stale: 'ETA 待刷新',
  drift: 'Jira 有变更',
  ok: '按期',
  done: '已交付',
};
const rank: Record<DependencyState, number> = {
  late: 0,
  missing: 1,
  stale: 2,
  drift: 3,
  ok: 4,
  done: 5,
};
export function dependencyGap(m: RoadmapMarker): number {
  return m.need && m.date ? diffD(m.need, m.date) : 0;
}
export function dependencyDrift(m: RoadmapMarker): boolean {
  return Boolean(
    m.jiraKey &&
    m.jiraFetchedAt &&
    (m.date || null) !== (m.jiraTargetEnd || null),
  );
}
export function dependencyState(m: RoadmapMarker): DependencyState {
  if (isDoneStatus({ status: m.jiraStatus })) return 'done';
  if (!m.date) return m.jiraKey && m.jiraTargetEnd ? 'stale' : 'missing';
  if (dependencyGap(m) > 0) return 'late';
  if (dependencyDrift(m)) return 'drift';
  return 'ok';
}
export function dependencyMatches(
  m: RoadmapMarker,
  filter: DependencyFilter,
): boolean {
  if (filter === 'all') return true;
  if (dependencyState(m) === 'done') return false;
  if (filter === 'late') return dependencyGap(m) > 0;
  if (filter === 'missing') return !m.date;
  return dependencyDrift(m);
}
export function dependencyGroups(
  items: RoadmapItem[],
  filter: DependencyFilter = 'all',
) {
  return items
    .map((item) => ({
      item,
      deps: (item.markers || [])
        .filter((m) => m.kind === 'dep' && dependencyMatches(m, filter))
        .sort(
          (a, b) =>
            rank[dependencyState(a)] - rank[dependencyState(b)] ||
            dependencyGap(b) - dependencyGap(a) ||
            a.id.localeCompare(b.id),
        ),
    }))
    .filter((g) => g.deps.length)
    .sort(
      (a, b) =>
        rank[dependencyState(a.deps[0])] - rank[dependencyState(b.deps[0])] ||
        dependencyGap(b.deps[0]) - dependencyGap(a.deps[0]),
    );
}
export function defaultDependencyNeed(item: RoadmapItem): string {
  return item.start && item.start > fmtISO(today)
    ? item.start
    : fmtISO(addD(today, 7));
}
export function snapDependencyNeed(
  date: string,
  eta?: string | null,
): string | null {
  return eta && Math.abs(diffD(date, eta)) <= 1 ? null : date;
}
export function dependencyTiming(m: RoadmapMarker): string {
  if (dependencyState(m) === 'done') return DEP_LABEL.done;
  const gap = dependencyGap(m);
  return gap > 0
    ? `晚 ${gap} 天`
    : gap < 0
      ? `余量 ${-gap} 天`
      : DEP_LABEL[dependencyState(m)];
}
