import { addDaysIso } from './assigneeMap.js';

/** Inclusive Gantt end date (`days` is a length, not a delta). */
export function ganttEndIso(
  start: string | null | undefined,
  days: number | null | undefined,
): string | null {
  if (!start || typeof days !== 'number' || !Number.isFinite(days) || days < 1) {
    return null;
  }
  return addDaysIso(start, Math.max(1, Math.floor(days)) - 1);
}

/**
 * True when the Gantt bar no longer matches the last mirrored Jira Target.
 * `target_*` is the last successful Jira read/write, not the live Jira issue.
 * Missing both target fields means "never mirrored" — let Jira apply.
 */
export function scheduleDivergesFromMirroredTarget(input: {
  start?: string | null;
  days?: number | null;
  targetStart?: string | null;
  targetEnd?: string | null;
}): boolean {
  const start = input.start || null;
  const days =
    typeof input.days === 'number' && Number.isFinite(input.days)
      ? Math.floor(input.days)
      : null;
  const targetStart = input.targetStart || null;
  const targetEnd = input.targetEnd || null;
  if (!start || !days || days < 1) return false;
  if (!targetStart && !targetEnd) return false;
  const end = ganttEndIso(start, days);
  if (targetStart && targetStart !== start) return true;
  if (targetEnd && end && targetEnd !== end) return true;
  return false;
}
