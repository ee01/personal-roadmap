import type { RoadmapItem } from '../types';
import { addD, diffD, parseDate, type Timeline } from './useGeometry';

export interface GanttTarget {
  itemKey: string;
  subId?: string;
  depId?: string;
}
export interface GanttLocation {
  target: GanttTarget;
  from: 'dependency' | 'resource' | null;
  scrollTop: number;
  scrollLeft: number;
  label: string;
  serial: number;
}
export function formatGanttFocus(target: GanttTarget): string {
  return (
    target.itemKey +
    (target.subId
      ? `:sub:${target.subId}`
      : target.depId
        ? `:dep:${target.depId}`
        : '')
  );
}
export function parseGanttFocus(value: string | null): GanttTarget | null {
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length === 1 && parts[0]) return { itemKey: parts[0] };
  if (parts.length !== 3 || !parts[0] || !parts[2]) return null;
  if (parts[1] === 'sub') return { itemKey: parts[0], subId: parts[2] };
  if (parts[1] === 'dep') return { itemKey: parts[0], depId: parts[2] };
  return null;
}
export function resolveGanttTarget(items: RoadmapItem[], target: GanttTarget) {
  const item = items.find((i) => i.key === target.itemKey && i.scheduled);
  if (!item || (target.subId && target.depId)) return null;
  const sub = target.subId
    ? item.subs.find((s) => s.id === target.subId && !s.cleared)
    : undefined;
  const dep = target.depId
    ? item.markers.find((m) => m.id === target.depId && m.kind === 'dep')
    : undefined;
  if ((target.subId && !sub) || (target.depId && !dep)) return null;
  return {
    item,
    sub,
    dep,
    date: sub?.start || dep?.date || dep?.need || item.start || null,
    label: sub
      ? sub.key || sub.alias || sub.title
      : dep
        ? `依赖 · ${dep.jiraKey || dep.label}`
        : item.jiraKey || item.alias || item.title,
  };
}
/** A deep link may point beyond the checked quarters. Extend only the local viewport. */
export function locateTimeline(
  base: Timeline,
  date: string | null | undefined,
): Timeline {
  if (!date) return base;
  const target = parseDate(date);
  if (target >= base.start && target <= base.end) return base;
  const start = target < base.start ? addD(target, -7) : base.start;
  const end = target > base.end ? addD(target, 14) : base.end;
  const months: Timeline['months'] = [];
  const now = new Date();
  for (
    let m = new Date(start.getFullYear(), start.getMonth(), 1);
    m <= end;
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1)
  ) {
    const first = m < start ? start : m;
    const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    months.push({
      y: m.getFullYear(),
      m: m.getMonth(),
      days: diffD(first, last > end ? end : last) + 1,
      cur:
        m.getMonth() === now.getMonth() &&
        m.getFullYear() === now.getFullYear(),
    });
  }
  return { start, end, days: diffD(start, end) + 1, months };
}
export const LOCATE_SVG =
  '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="3.5"/><circle cx="7" cy="7" r=".6" fill="currentColor"/><path d="M7 0v3M7 11v3M0 7h3M11 7h3"/></svg>';
