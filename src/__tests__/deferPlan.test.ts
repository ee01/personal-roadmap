import { describe, expect, it } from 'vitest';
import { planDeferToTarget } from '../core/deferPlan.js';

describe('planDeferToTarget', () => {
  it('keeps length when the Epic still has room from next Monday', () => {
    const plan = planDeferToTarget({
      subStart: '2026-08-28',
      subDays: 6,
      epicStart: '2026-08-17',
      epicDays: 34,
      targetStart: '2026-08-31',
    });
    expect(plan.fit).toBe('fit');
    expect(plan.nextStart).toBe('2026-08-31');
    expect(plan.nextDays).toBe(6);
  });

  it('shrinks down to remaining room when it still covers Original Estimate', () => {
    const plan = planDeferToTarget({
      subStart: '2026-08-24',
      subDays: 26,
      epicStart: '2026-08-17',
      epicDays: 34,
      targetStart: '2026-08-31',
      originalEstimateDays: 5,
    });
    expect(plan.fit).toBe('shrink');
    expect(plan.nextStart).toBe('2026-08-31');
    expect(plan.nextDays).toBe(20); // 08-31 → 09-19 inclusive
    expect(plan.minDays).toBe(5);
  });

  it('asks to extend the Epic when Monday-to-end cannot fit min days', () => {
    const plan = planDeferToTarget({
      subStart: '2026-09-01',
      subDays: 9,
      epicStart: '2026-07-25',
      epicDays: 44,
      targetStart: '2026-09-07',
      originalEstimateDays: 3,
    });
    // epic 07-25 + 43d = 09-06; Monday 09-07 has 0 days of room
    expect(plan.fit).toBe('needs-extend');
    expect(plan.neededEpicEnd).toBe('2026-09-09');
    expect(plan.nextStart).toBeNull();
  });

  it('is a no-op when the sub already starts on the target with a valid length', () => {
    const plan = planDeferToTarget({
      subStart: '2026-08-31',
      subDays: 3,
      epicStart: '2026-08-17',
      epicDays: 34,
      targetStart: '2026-08-31',
    });
    expect(plan.fit).toBe('noop');
  });
});
