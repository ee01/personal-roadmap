/**
 * Jira Custom Labels (`customfield_33875`) → milestone filter domain.
 *
 * On a Jira issue the field holds `LabelKey:ValueKey` pairs separated by
 * newlines (e.g. `LBL-288:LBL-291`). Labels and values are issues in the LBL
 * project: the Label groups values (LBL-288 "AIR 2.0 Milestones"), the value
 * carries name + description. Milestone dates are NOT a structured field —
 * they are written in the value's description first line
 * (`Milestone: 11/30/26`), so the date is resolved lazily with fallbacks.
 */

export interface CustomLabelPair {
  labelKey: string;
  valueKey: string;
}

const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9]+-\d+$/;

function toPair(labelKey: unknown, valueKey: unknown): CustomLabelPair | null {
  const label = String(labelKey || '').trim();
  const value = String(valueKey || '').trim();
  if (!ISSUE_KEY_RE.test(value)) return null;
  return { labelKey: ISSUE_KEY_RE.test(label) ? label : '', valueKey: value };
}

/**
 * Accept the raw Jira field (`"LBL-288:LBL-291\nLBL-288:LBL-297"`), an
 * already-parsed pair array from the page bridge, or anything else and return
 * de-duplicated pairs. `labelKey` may be empty when the stored line did not
 * carry a well-formed label key; the value key is what matters for filtering.
 */
export function parseCustomLabelsField(raw: unknown): CustomLabelPair[] {
  const out: CustomLabelPair[] = [];
  const seen = new Set<string>();
  const push = (pair: CustomLabelPair | null) => {
    if (!pair || seen.has(pair.valueKey)) return;
    seen.add(pair.valueKey);
    out.push(pair);
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      push(toPair(row.labelKey, row.valueKey));
    }
    return out;
  }

  const text = String(raw ?? '');
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) {
      push(toPair('', line));
      continue;
    }
    push(toPair(line.slice(0, idx), line.slice(idx + 1)));
  }
  return out;
}

/** Value keys only — what the items API exposes as `ms` and filters match on. */
export function customLabelValueKeys(pairs: CustomLabelPair[]): string[] {
  return pairs.map((pair) => pair.valueKey);
}

/** Read back the JSON pairs persisted in `items.custom_labels_json`. */
export function parseStoredCustomLabels(
  raw: string | null | undefined,
): CustomLabelPair[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parseCustomLabelsField(parsed) : [];
  } catch {
    return [];
  }
}

export type MilestoneDateSource = 'duedate' | 'targetEnd' | 'description';

export interface ResolvedMilestoneDate {
  date: string;
  source: MilestoneDateSource;
}

function isoDateOrNull(value: unknown): string | null {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return text;
}

/** `Milestone: 11/30/26` / `Milestone - 1/31/27` — first line of LBL descriptions. */
const MILESTONE_DATE_RE =
  /^[ \t]*Milestone[ \t]*[:\-–][ \t]*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/i;

function fromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = MILESTONE_DATE_RE.exec(description);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Date strategy: first non-empty of Due Date → Target End → description regex.
 * Covers all current LBL-288 values; when maintainers start filling Due Date
 * it wins automatically with no code change.
 */
export function resolveMilestoneDate(input: {
  dueDate?: string | null;
  targetEnd?: string | null;
  description?: string | null;
}): ResolvedMilestoneDate | null {
  const dueDate = isoDateOrNull(input.dueDate);
  if (dueDate) return { date: dueDate, source: 'duedate' };
  const targetEnd = isoDateOrNull(input.targetEnd);
  if (targetEnd) return { date: targetEnd, source: 'targetEnd' };
  const described = fromDescription(input.description);
  if (described) return { date: described, source: 'description' };
  return null;
}
