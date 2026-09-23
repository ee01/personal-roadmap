import { describe, expect, it } from 'vitest';
import {
  coerceOriginalEstimateDays,
  minTaskDays,
  originalEstimateFromJiraFields,
  originalEstimateSecondsToDays,
  SECONDS_PER_MAN_DAY,
} from '../core/originalEstimate.js';

describe('originalEstimateSecondsToDays', () => {
  it('ceils 8-hour days and treats empty as null', () => {
    expect(originalEstimateSecondsToDays(SECONDS_PER_MAN_DAY)).toBe(1);
    expect(originalEstimateSecondsToDays(SECONDS_PER_MAN_DAY + 1)).toBe(2);
    expect(originalEstimateSecondsToDays(3 * SECONDS_PER_MAN_DAY)).toBe(3);
    expect(originalEstimateSecondsToDays(0)).toBeNull();
    expect(originalEstimateSecondsToDays(null)).toBeNull();
    expect(originalEstimateSecondsToDays('86400')).toBe(3);
  });
});

describe('coerceOriginalEstimateDays', () => {
  it('keeps small values as man-days and large values as seconds', () => {
    expect(coerceOriginalEstimateDays(5)).toBe(5);
    expect(coerceOriginalEstimateDays(4.2)).toBe(5);
    expect(coerceOriginalEstimateDays(SECONDS_PER_MAN_DAY)).toBe(1);
    expect(coerceOriginalEstimateDays(0)).toBeNull();
  });
});

describe('originalEstimateFromJiraFields', () => {
  it('prefers timeoriginalestimate then timetracking seconds', () => {
    expect(
      originalEstimateFromJiraFields({ timeoriginalestimate: SECONDS_PER_MAN_DAY * 2 }),
    ).toBe(2);
    expect(
      originalEstimateFromJiraFields({
        timetracking: { originalEstimateSeconds: SECONDS_PER_MAN_DAY },
      }),
    ).toBe(1);
  });
});

describe('minTaskDays', () => {
  it('defaults to 3 when Jira estimate is missing', () => {
    expect(minTaskDays(null)).toBe(3);
    expect(minTaskDays(undefined)).toBe(3);
    expect(minTaskDays(1.2)).toBe(2);
  });
});
