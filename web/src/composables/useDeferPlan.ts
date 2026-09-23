import { addD, diffD, fmtISO, parseDate } from './useGeometry';

/** Same default as `roadmap-service/src/core/originalEstimate.ts`. */
export const DEFAULT_MIN_TASK_DAYS = 3;

export function minTaskDays(
  originalEstimateDays: number | null | undefined,
): number {
  if (
    typeof originalEstimateDays === 'number' &&
    Number.isFinite(originalEstimateDays) &&
    originalEstimateDays > 0
  ) {
    return Math.max(1, Math.ceil(originalEstimateDays));
  }
  return DEFAULT_MIN_TASK_DAYS;
}

export type DeferFit = 'fit' | 'shrink' | 'needs-extend' | 'noop';

export interface DeferPlan {
  fit: DeferFit;
  minDays: number;
  epicEnd: Date;
  roomFromTarget: number;
  neededEpicEnd: Date;
  nextStart: Date | null;
  nextDays: number | null;
}

/**
 * Mirror of `roadmap-service/src/core/deferPlan.ts` using local Date math
 * so the resource-view preview matches the server commit.
 */
export function planDeferToTarget(input: {
  subStart: string;
  subDays: number;
  epicStart: string;
  epicDays: number;
  targetStart: Date | string;
  originalEstimateDays?: number | null;
}): DeferPlan {
  const minDays = minTaskDays(input.originalEstimateDays);
  const origDays = Math.max(1, input.subDays || 1);
  const epicEnd = addD(input.epicStart, Math.max(1, input.epicDays || 1) - 1);
  const target =
    typeof input.targetStart === 'string'
      ? parseDate(input.targetStart)
      : input.targetStart;
  const neededEpicEnd = addD(target, minDays - 1);
  const delay = diffD(input.subStart, target);
  const roomFromTarget = diffD(target, epicEnd) + 1;

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
      nextStart: target,
      nextDays,
    };
  }

  return {
    fit,
    minDays,
    epicEnd,
    roomFromTarget,
    neededEpicEnd,
    nextStart: target,
    nextDays,
  };
}

export function planIso(plan: DeferPlan): {
  neededEpicEnd: string;
  nextStart: string | null;
} {
  return {
    neededEpicEnd: fmtISO(plan.neededEpicEnd),
    nextStart: plan.nextStart ? fmtISO(plan.nextStart) : null,
  };
}
