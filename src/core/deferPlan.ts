import { addDaysIso, diffDaysIso } from './assigneeMap.js';
import { minTaskDays } from './originalEstimate.js';

export type DeferFit = 'fit' | 'shrink' | 'needs-extend' | 'noop';

export interface DeferPlan {
  fit: DeferFit;
  minDays: number;
  epicEnd: string;
  roomFromTarget: number;
  neededEpicEnd: string;
  nextStart: string | null;
  nextDays: number | null;
}

/**
 * Plan moving a sub so it starts on `targetStart` (next Monday).
 * Length stays the same when the Epic still has room; otherwise shrink down
 * to Original Estimate man-days (default 3). If even that does not fit
 * between targetStart and the Epic end, the caller should ask to extend
 * the Epic to `neededEpicEnd`.
 */
export function planDeferToTarget(input: {
  subStart: string;
  subDays: number;
  epicStart: string;
  epicDays: number;
  targetStart: string;
  originalEstimateDays?: number | null;
}): DeferPlan {
  const minDays = minTaskDays(input.originalEstimateDays);
  const origDays = Math.max(1, input.subDays || 1);
  const epicEnd = addDaysIso(input.epicStart, Math.max(1, input.epicDays || 1) - 1);
  const neededEpicEnd = addDaysIso(input.targetStart, minDays - 1);
  const delay = diffDaysIso(input.subStart, input.targetStart);
  const roomFromTarget = diffDaysIso(input.targetStart, epicEnd) + 1;

  if (delay < 0) {
    return {
      fit: 'noop',
      minDays,
      epicEnd,
      roomFromTarget,
      neededEpicEnd,
      nextStart: null,
      nextDays: null,
    };
  }

  let fit: DeferFit;
  let nextDays: number;
  if (roomFromTarget >= origDays) {
    fit = 'fit';
    nextDays = origDays;
  } else if (roomFromTarget >= minDays) {
    fit = 'shrink';
    nextDays = roomFromTarget;
  } else {
    return {
      fit: 'needs-extend',
      minDays,
      epicEnd,
      roomFromTarget,
      neededEpicEnd,
      nextStart: null,
      nextDays: null,
    };
  }

  if (delay === 0 && nextDays === origDays) {
    return {
      fit: 'noop',
      minDays,
      epicEnd,
      roomFromTarget,
      neededEpicEnd,
      nextStart: input.targetStart,
      nextDays,
    };
  }

  return {
    fit,
    minDays,
    epicEnd,
    roomFromTarget,
    neededEpicEnd,
    nextStart: input.targetStart,
    nextDays,
  };
}
