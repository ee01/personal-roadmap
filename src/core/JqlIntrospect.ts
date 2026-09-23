import type { JqlHints } from '../types.js';

/** Parent Link — used when the main item is an Initiative and children are Epics. */
export const PARENT_LINK_FIELD = 'customfield_15751';
/** Epic Link — used when the main item is an Epic and children are Tasks. */
export const EPIC_LINK_FIELD = 'customfield_11450';
/** Native sub-task relation — used when the main item is Task level. */
export const PARENT_FIELD = 'parent';

export const DEFAULT_ITEM_TYPE = 'Epic';

const TYPE_CANONICAL: Record<string, string> = {
  initiative: 'Initiative',
  epic: 'Epic',
  task: 'Task',
  story: 'Story',
  'user story': 'User Story',
  bug: 'Bug',
  'sub-task': 'Sub-task',
  subtask: 'Sub-task',
};

/**
 * Restore the canonical Jira casing for the issue types we know about.
 * Unknown types are returned trimmed but otherwise untouched, because Jira
 * issue type names are case sensitive when they get posted back.
 */
export function canonicalizeItemType(
  raw: string | null | undefined,
): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  return TYPE_CANONICAL[trimmed.toLowerCase()] || trimmed;
}

/**
 * Drop every single-quoted substring.
 *
 * This has to happen before any field matching: real-world JQL nests a whole
 * second query inside `portfolioChildrenOf('project = INIT AND ...')`, and the
 * inner `project` / `issuetype` clauses describe the parents, not the rows we
 * are importing.
 */
export function stripQuotedSegments(jql: string): string {
  return jql.replace(/'(?:[^'\\]|\\.)*'/g, ' ');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

function firstListValue(list: string): string | null {
  const first = list.split(',')[0] || '';
  return unquote(first) || null;
}

/**
 * Match `field = value` or `field in (a, b)` and return the first value.
 * Negated clauses (`not in`) are intentionally ignored — they exclude values
 * rather than declaring the one we are looking for.
 */
function matchFieldValue(jql: string, fieldPattern: string): string | null {
  const listMatch = new RegExp(
    `\\b(?:${fieldPattern})\\s*(?:=|\\bin\\b)\\s*\\(([^)]*)\\)`,
    'i',
  ).exec(jql);
  if (listMatch) {
    const value = firstListValue(listMatch[1]);
    if (value) return value;
  }
  const eqMatch = new RegExp(
    `\\b(?:${fieldPattern})\\s*=\\s*("[^"]*"|[^\\s()]+)`,
    'i',
  ).exec(jql);
  if (eqMatch) {
    const value = unquote(eqMatch[1]);
    if (value) return value;
  }
  return null;
}

export function parseProjectKey(jql: string | null | undefined): string | null {
  if (!jql) return null;
  const value = matchFieldValue(stripQuotedSegments(jql), 'project');
  if (!value) return null;
  const cleaned = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]*$/.test(cleaned) ? cleaned : null;
}

export function parseIssueType(jql: string | null | undefined): string | null {
  if (!jql) return null;
  return canonicalizeItemType(
    matchFieldValue(stripQuotedSegments(jql), 'issuetype|issue\\s+type'),
  );
}

export function parseJql(jql: string | null | undefined): {
  projectKey: string | null;
  itemType: string | null;
} {
  return {
    projectKey: parseProjectKey(jql),
    itemType: parseIssueType(jql),
  };
}

/**
 * Which issue type the children of `itemType` should be, and which field links
 * them back to the parent. `subType: null` means "ask createmeta for the
 * project's sub-task type" — we deliberately do not hardcode "Sub-task".
 */
export function resolveSubType(itemType: string | null | undefined): {
  subType: string | null;
  linkField: string | null;
} {
  const normalized = (itemType || '').trim().toLowerCase();
  if (normalized === 'initiative' || normalized === 'init') {
    return { subType: 'Epic', linkField: PARENT_LINK_FIELD };
  }
  if (normalized === 'epic') {
    return { subType: 'Task', linkField: EPIC_LINK_FIELD };
  }
  // Task / Story / User Story / Bug and anything unrecognised is treated as Task level.
  return { subType: null, linkField: PARENT_FIELD };
}

/**
 * Fallback chain for the item type: JQL parse -> mode of the team's already
 * imported item types -> `Epic` with `confident: false` so the UI can refuse to
 * guess on the user's behalf.
 */
export function buildJqlHints(input: {
  jql?: string | null;
  modeItemType?: string | null;
}): JqlHints {
  const parsed = parseJql(input.jql);
  const fromMode = parsed.itemType
    ? null
    : canonicalizeItemType(input.modeItemType);
  const itemType = parsed.itemType || fromMode || DEFAULT_ITEM_TYPE;
  const { subType, linkField } = resolveSubType(itemType);
  return {
    projectKey: parsed.projectKey,
    itemType,
    subType,
    linkField,
    confident: Boolean(parsed.itemType || fromMode),
  };
}
