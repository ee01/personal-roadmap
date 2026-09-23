import { describe, expect, it } from 'vitest';
import { fitTargetWindow, targetWindow } from '../composables/useRoadmapState';

const d = (s: string) => {
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, m - 1, day);
};
const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

describe('targetWindow', () => {
  it('returns null when the item has no Target at all', () => {
    expect(targetWindow({ targetStart: null, targetEnd: null, estimate: 2 })).toBeNull();
  });

  it('uses both ends verbatim', () => {
    const win = targetWindow({ targetStart: '2026-10-01', targetEnd: '2026-10-15', estimate: 2 })!;
    expect(iso(win.start)).toBe('2026-10-01');
    expect(iso(win.end)).toBe('2026-10-15');
    expect(win.days).toBe(15);
  });

  // 用户报的 bug：Backlog 只填 Target 结束 → 拖到甘特后 bar 必须落在结束日上
  it('back-fills the start from Target End and the estimate', () => {
    const win = targetWindow({ targetStart: null, targetEnd: '2026-11-30', estimate: 2 })!;
    expect(iso(win.end)).toBe('2026-11-30');
    expect(win.days).toBe(14);
    expect(iso(win.start)).toBe('2026-11-17');
  });

  it('fills the end from Target Start and the estimate', () => {
    const win = targetWindow({ targetStart: '2026-10-05', targetEnd: null, estimate: 2 })!;
    expect(iso(win.start)).toBe('2026-10-05');
    expect(win.days).toBe(14);
    expect(iso(win.end)).toBe('2026-10-18');
  });

  it('falls back to the 3-week default estimate', () => {
    const win = targetWindow({ targetStart: null, targetEnd: '2026-11-30', estimate: null })!;
    expect(win.days).toBe(21);
    expect(iso(win.start)).toBe('2026-11-10');
  });

  it('never inverts a dirty end-before-start window', () => {
    const win = targetWindow({ targetStart: '2026-10-15', targetEnd: '2026-10-01', estimate: 2 })!;
    expect(win.days).toBe(1);
    expect(iso(win.start)).toBe('2026-10-15');
    expect(iso(win.end)).toBe('2026-10-15');
  });
});

describe('fitTargetWindow', () => {
  const tlStart = d('2026-06-01');
  const tlEnd = d('2027-03-31');

  it('keeps an in-range window untouched', () => {
    const win = targetWindow({ targetStart: '2026-10-01', targetEnd: '2026-10-15', estimate: 2 })!;
    const fit = fitTargetWindow(win, tlStart, tlEnd);
    expect(iso(fit.start)).toBe('2026-10-01');
    expect(fit.days).toBe(15);
  });

  it('pulls an end past the timeline back into range without shrinking to 1 day', () => {
    const win = targetWindow({ targetStart: '2027-03-20', targetEnd: '2027-04-30', estimate: 2 })!;
    const fit = fitTargetWindow(win, tlStart, tlEnd);
    expect(fit.days).toBe(42);
    expect(iso(addDays(fit.start, fit.days - 1))).toBe('2027-03-31');
    expect(fit.start >= tlStart).toBe(true);
  });

  it('moves a fully-past window to the timeline start, keeping its length', () => {
    const win = targetWindow({ targetStart: '2026-01-01', targetEnd: '2026-01-20', estimate: 2 })!;
    const fit = fitTargetWindow(win, tlStart, tlEnd);
    expect(iso(fit.start)).toBe('2026-06-01');
    expect(fit.days).toBe(20);
  });

  it('caps a window longer than the timeline to the whole timeline', () => {
    const win = {
      start: d('2025-01-01'),
      end: d('2028-01-01'),
      days: 1097,
    };
    const fit = fitTargetWindow(win, tlStart, tlEnd);
    expect(iso(fit.start)).toBe('2026-06-01');
    expect(fit.days).toBe(304);
  });

  it('never returns fewer than 2 days', () => {
    const win = targetWindow({ targetStart: '2026-10-15', targetEnd: '2026-10-01', estimate: 1 })!;
    const fit = fitTargetWindow(win, tlStart, tlEnd);
    expect(fit.days).toBeGreaterThanOrEqual(2);
    // 1 天的窗口向补齐到 2 天时保住结束日，往前借一天
    expect(iso(addDays(fit.start, fit.days - 1))).toBe('2026-10-15');
  });
});

function addDays(date: Date, n: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}
