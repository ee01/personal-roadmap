/** Jira issue key stored as an item's Parent Link (typically an INIT). */
const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

export function parseParentLink(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: 'invalid_parent_link' } {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: null };
  const fromBrowse = text.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\b/i);
  const candidate = (fromBrowse?.[1] || text).trim();
  const match = ISSUE_KEY.exec(candidate);
  if (!match) return { ok: false, error: 'invalid_parent_link' };
  return { ok: true, value: `${match[1].toUpperCase()}-${match[2]}` };
}
