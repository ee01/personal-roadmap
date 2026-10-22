import { describe, expect, it } from 'vitest';
import {
  formatGanttFocus,
  parseGanttFocus,
  resolveGanttTarget,
  locateTimeline,
} from '../composables/ganttLocate';
import { computeTL, fmtISO } from '../composables/useGeometry';
import type { RoadmapItem } from '../types';
const item = {
  key: 'LOCAL-1',
  jiraKey: 'QA-1',
  title: 'Host',
  scheduled: true,
  start: '2026-10-20',
  subs: [
    { id: 'sub_A', key: 'QA-2', start: '2026-10-25' },
    { id: 'removed', cleared: true },
  ],
  markers: [
    {
      id: 'dep_A',
      kind: 'dep',
      label: 'API',
      date: '2026-11-05',
      need: '2026-11-01',
    },
    { id: 'pending', kind: 'dep', label: 'Manual', need: '2026-11-03' },
  ],
} as RoadmapItem;
describe('independent Gantt navigation', () => {
  it('round trips exact epic, child and dependency targets without modifying other URL parameters', () => {
    for (const target of [
      { itemKey: 'LOCAL-1' },
      { itemKey: 'LOCAL-1', subId: 'sub_A' },
      { itemKey: 'LOCAL-1', depId: 'dep_A' },
    ]) {
      const url = new URL('http://example.test/?q=2026-Q4&search=original');
      url.searchParams.set('focus', formatGanttFocus(target));
      expect(parseGanttFocus(url.searchParams.get('focus'))).toEqual(target);
      expect(url.searchParams.get('q')).toBe('2026-Q4');
      expect(url.searchParams.get('search')).toBe('original');
    }
    for (const invalid of [
      null,
      '',
      'a:dep',
      'a:other:id',
      ':sub:id',
      'a:sub:',
      'a:dep:id:extra',
    ])
      expect(parseGanttFocus(invalid)).toBeNull();
  });
  it('resolves the exact child or ETA/expected marker, including drafts, and rejects removed targets', () => {
    expect(resolveGanttTarget([item], { itemKey: item.key })?.date).toBe(
      item.start,
    );
    expect(
      resolveGanttTarget([item], { itemKey: item.key, subId: 'sub_A' })?.date,
    ).toBe('2026-10-25');
    expect(
      resolveGanttTarget([item], { itemKey: item.key, depId: 'dep_A' })?.date,
    ).toBe('2026-11-05');
    expect(
      resolveGanttTarget([item], { itemKey: item.key, depId: 'pending' })?.date,
    ).toBe('2026-11-03');
    for (const target of [
      { itemKey: item.key, subId: 'removed' },
      { itemKey: item.key, depId: 'absent' },
      { itemKey: 'missing' },
    ])
      expect(resolveGanttTarget([item], target)).toBeNull();
    expect(
      resolveGanttTarget([{ ...item, scheduled: false }], {
        itemKey: item.key,
      }),
    ).toBeNull();
    expect(
      resolveGanttTarget([item], {
        itemKey: item.key,
        depId: 'dep_A',
        subId: 'sub_A',
      }),
    ).toBeNull();
    expect(
      resolveGanttTarget(
        [
          {
            ...item,
            jiraKey: null,
            subs: [{ id: 'draft', title: 'Draft task', temp: true }],
          } as RoadmapItem,
        ],
        { itemKey: item.key, subId: 'draft' },
      )?.label,
    ).toBe('Draft task');
  });
  it('extends only the viewport when a target lies outside the checked timeline', () => {
    const base = computeTL(['2026-Q4']);
    const before = fmtISO(base.start);
    const extended = locateTimeline(base, '2024-01-01');
    expect(fmtISO(extended.start)).toBe('2023-12-25');
    expect(extended.days).toBeGreaterThan(base.days);
    expect(extended.months.reduce((n, m) => n + m.days, 0)).toBe(extended.days);
    expect(fmtISO(base.start)).toBe(before);
    expect(locateTimeline(base, '2030-12-31').end.getFullYear()).toBe(2031);
    expect(locateTimeline(base, fmtISO(base.start))).toBe(base);
  });
});
