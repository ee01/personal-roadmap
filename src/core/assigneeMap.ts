/**
 * Map Jira Task Target Start/End onto a parent epic's Gantt span.
 * Missing ends fall back per R8 (same as parent / 2-week clamp).
 */
export function importedTaskSpan(
  epic: { start: string; days: number },
  targetStart: string | null | undefined,
  targetEnd: string | null | undefined,
): { start: string; days: number } {
  const S = epic.start;
  const E = addDaysIso(epic.start, epic.days - 1);
  const ts = targetStart?.trim() || null;
  const te = targetEnd?.trim() || null;

  if (ts && te) {
    return { start: ts, days: Math.max(1, diffDaysIso(ts, te) + 1) };
  }
  if (!ts && !te) {
    return { start: S, days: Math.max(1, epic.days) };
  }
  if (ts) {
    let start = ts < S ? S : ts;
    if (start > E) start = E;
    let end = addDaysIso(start, 13);
    if (end > E) end = E;
    return { start, days: Math.max(1, diffDaysIso(start, end) + 1) };
  }
  // only end
  let end = te! > E ? E : te!;
  if (end < S) end = S;
  let start = addDaysIso(end, -13);
  if (start < S) start = S;
  return { start, days: Math.max(1, diffDaysIso(start, end) + 1) };
}

function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysIso(iso: string, n: number): string {
  const d = parseIso(iso);
  return fmtIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

export function diffDaysIso(a: string, b: string): number {
  const ms = 86_400_000;
  return Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / ms);
}

export function parseAssigneeMap(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = String(k || '').trim().toLowerCase();
      const val = String(v || '').trim();
      if (key && val) out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

export function normalizeAssigneeMap(
  input: unknown,
): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = String(k || '').trim().toLowerCase();
    const val = String(v || '').trim();
    if (key && val) out[key] = val;
  }
  return out;
}

/** Migrate map key when a member is renamed (system name is the map key). */
export function migrateAssigneeMapKey(
  map: Record<string, string>,
  fromName: string,
  toName: string,
): Record<string, string> {
  const from = fromName.trim().toLowerCase();
  const to = toName.trim().toLowerCase();
  if (!from || !to || from === to) return map;
  if (!(from in map)) return map;
  const next = { ...map };
  if (!(to in next)) next[to] = next[from];
  delete next[from];
  return next;
}

/**
 * Merge two identities in the assignee map: canonical key gets the full name,
 * and the short-name key is kept as an alias so lingering actorName / refs still resolve.
 */
export function mergeAssigneeMapIdentities(
  map: Record<string, string>,
  fromName: string,
  toName: string,
): Record<string, string> {
  const from = fromName.trim().toLowerCase();
  const canonical = toName.trim();
  const to = canonical.toLowerCase();
  if (!from || !to || from === to) return map;
  const next = { ...map };
  next[to] = canonical;
  next[from] = canonical;
  return next;
}

/** True when a display/system name looks like Jira Firstname Lastname (≥2 words). */
export function looksFullName(name: string | null | undefined): boolean {
  return String(name || '').trim().split(/\s+/).filter(Boolean).length >= 2;
}

export function mapGet(
  map: Record<string, string> | null | undefined,
  name: string | null | undefined,
): string | null {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return map?.[key] || null;
}

export function effectiveFullName(
  map: Record<string, string> | null | undefined,
  name: string | null | undefined,
): string | null {
  return mapGet(map, name) || (looksFullName(name) ? String(name).trim() : null);
}

/**
 * Refresh direction: Jira assignee display name vs local owner.
 * Same person (mapped full name, alias key, or exact match) → do not rewrite owner.
 */
export function ownerMatchesAssignee(
  map: Record<string, string> | null | undefined,
  owner: string | null | undefined,
  assigneeDisplay: string | null | undefined,
): boolean {
  const assignee = String(assigneeDisplay || '').trim();
  const own = String(owner || '').trim();
  if (!assignee || !own) return false;
  if (own.toLowerCase() === assignee.toLowerCase()) return true;
  const ownerFull = effectiveFullName(map, own);
  if (ownerFull && ownerFull.toLowerCase() === assignee.toLowerCase()) return true;
  for (const [k, v] of Object.entries(map || {})) {
    if (v.toLowerCase() === assignee.toLowerCase() && k === own.toLowerCase()) {
      return true;
    }
  }
  return false;
}

export function clipDescription(raw: unknown, max = 2000): string | null {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

export function daysBetweenIso(start: string, end: string): number {
  return Math.max(1, diffDaysIso(start, end) + 1);
}
