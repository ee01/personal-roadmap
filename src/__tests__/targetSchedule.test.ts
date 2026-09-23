import { describe, expect, it } from 'vitest';
import {
  ganttEndIso,
  scheduleDivergesFromMirroredTarget,
} from '../core/targetSchedule.js';

describe('scheduleDivergesFromMirroredTarget', () => {
  it('is false when the Gantt span still matches last mirrored Target', () => {
    expect(
      scheduleDivergesFromMirroredTarget({
        start: '2026-08-01',
        days: 14,
        targetStart: '2026-08-01',
        targetEnd: '2026-08-14',
      }),
    ).toBe(false);
    expect(ganttEndIso('2026-08-01', 14)).toBe('2026-08-14');
  });

  it('is true after a local resize that did not confirm to Jira', () => {
    expect(
      scheduleDivergesFromMirroredTarget({
        start: '2026-08-01',
        days: 21,
        targetStart: '2026-08-01',
        targetEnd: '2026-08-14',
      }),
    ).toBe(true);
  });

  it('is false when Target was never mirrored', () => {
    expect(
      scheduleDivergesFromMirroredTarget({
        start: '2026-08-01',
        days: 21,
        targetStart: null,
        targetEnd: null,
      }),
    ).toBe(false);
  });
});
