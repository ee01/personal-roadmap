import { describe, expect, it } from 'vitest';
import { planDeferToTarget } from '../composables/useDeferPlan';

describe('planDeferToTarget (web)', () => {
  it('shrinks to remaining room when Original Estimate still fits', () => {
    const plan = planDeferToTarget({
      subStart: '2026-08-24',
      subDays: 26,
      epicStart: '2026-08-17',
      epicDays: 34,
      targetStart: '2026-08-31',
      originalEstimateDays: 5,
    });
    expect(plan.fit).toBe('shrink');
    expect(plan.nextDays).toBe(20);
  });

  it('needs an Epic extend when Monday-to-end is shorter than min days', () => {
    const plan = planDeferToTarget({
      subStart: '2026-09-01',
      subDays: 9,
      epicStart: '2026-07-25',
      epicDays: 44,
      targetStart: '2026-09-07',
    });
    expect(plan.fit).toBe('needs-extend');
    expect(plan.minDays).toBe(3);
  });
});
