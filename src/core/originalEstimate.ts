/** Jira `timeoriginalestimate` is seconds. One man-day = 8 hours. */
export const SECONDS_PER_MAN_DAY = 8 * 3600;

export const DEFAULT_MIN_TASK_DAYS = 3;

/** Ceil seconds into man-days. Empty / 0 / invalid → null. */
export function originalEstimateSecondsToDays(raw: unknown): number | null {
  let seconds: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) seconds = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) seconds = n;
  }
  if (seconds == null || seconds <= 0) return null;
  return Math.max(1, Math.ceil(seconds / SECONDS_PER_MAN_DAY));
}

/**
 * Accept already-converted man-days (from the extension) or raw Jira seconds.
 * Values ≥ 3600 are treated as seconds so PAT import and refresh payloads
 * can send either shape.
 */
export function coerceOriginalEstimateDays(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return null;
    if (raw >= SECONDS_PER_MAN_DAY / 8) {
      return originalEstimateSecondsToDays(raw);
    }
    return Math.max(1, Math.ceil(raw));
  }
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return coerceOriginalEstimateDays(n);
  }
  return null;
}

export function originalEstimateFromJiraFields(
  fields: Record<string, unknown> | null | undefined,
): number | null {
  if (!fields) return null;
  const fromSeconds = originalEstimateSecondsToDays(fields.timeoriginalestimate);
  if (fromSeconds) return fromSeconds;
  const tracking = fields.timetracking;
  if (tracking && typeof tracking === 'object') {
    const t = tracking as { originalEstimateSeconds?: unknown };
    const fromTrack = originalEstimateSecondsToDays(t.originalEstimateSeconds);
    if (fromTrack) return fromTrack;
  }
  return null;
}

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
