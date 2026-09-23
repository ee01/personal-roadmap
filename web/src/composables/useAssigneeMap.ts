import { addD, fmtISO, today } from './useGeometry';
import type { RoadmapItem, RoadmapSub, TeamMember, TeamSnapshot } from '../types';

export type AssigneeMap = Record<string, string>;

export interface PersonRow {
  name: string;
  sources: Set<string>;
}

export interface ResolvedAssignee {
  name: string;
  full: string | null;
  user: string | null;
  fallback: boolean;
}

export function looksFullName(name: string | null | undefined): boolean {
  return String(name || '').trim().split(/\s+/).filter(Boolean).length >= 2;
}

export function jiraUsernameFromFull(full: string): string {
  return String(full)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join('.');
}

export function mapGet(
  map: AssigneeMap | null | undefined,
  name: string | null | undefined,
): string | null {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return map?.[key] || null;
}

export function effectiveFullName(
  map: AssigneeMap | null | undefined,
  name: string | null | undefined,
): string | null {
  return mapGet(map, name) || (looksFullName(name) ? String(name).trim() : null);
}

export function dispName(
  map: AssigneeMap | null | undefined,
  name: string | null | undefined,
): string {
  if (!name) return '';
  return mapGet(map, name) || name;
}

export function collectPeople(input: {
  currentUser: string;
  members: TeamMember[];
  items: RoadmapItem[];
}): PersonRow[] {
  const map = new Map<string, PersonRow>();
  const add = (n: string | null | undefined, src: string) => {
    const name = String(n || '').trim();
    if (!name) return;
    const lk = name.toLowerCase();
    if (!map.has(lk)) map.set(lk, { name, sources: new Set() });
    map.get(lk)!.sources.add(src);
  };
  add(input.currentUser, '成员');
  for (const m of input.members) add(m.name, '成员');
  for (const it of input.items) {
    for (const s of it.subs || []) {
      if (s.owner) add(s.owner, '成员');
      if (s.createdBy) add(s.createdBy, '创建过任务');
    }
  }
  return [...map.values()];
}

/**
 * Suggest existing people whose system name already looks like Firstname Lastname.
 * Used by Assignee 映射输入框；选中后应触发 merge_people。
 */
export function suggestFullNamePeople(
  people: PersonRow[],
  query: string,
  excludeName: string,
): PersonRow[] {
  const q = String(query || '').trim().toLowerCase();
  const ex = String(excludeName || '').trim().toLowerCase();
  return people
    .filter((p) => looksFullName(p.name) && p.name.toLowerCase() !== ex)
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function resolveAssignee(input: {
  map: AssigneeMap | null | undefined;
  sub: Pick<RoadmapSub, 'owner' | 'createdBy' | 'ownerResolution'>;
  currentUser: string;
}): ResolvedAssignee {
  if (
    input.sub.ownerResolution === 'ambiguous' ||
    input.sub.ownerResolution === 'unassigned'
  ) {
    const name = input.sub.owner || '';
    const full = name ? effectiveFullName(input.map, name) : null;
    return {
      name,
      fallback: false,
      full,
      user: full ? jiraUsernameFromFull(full) : null,
    };
  }
  const fallback = !input.sub.owner;
  const name = input.sub.owner || input.sub.createdBy || input.currentUser;
  const full = effectiveFullName(input.map, name);
  return {
    name,
    fallback,
    full,
    user: full ? jiraUsernameFromFull(full) : null,
  };
}

export function defaultNewSubSpan(tlEnd?: Date | string | null): {
  start: string;
  days: number;
} {
  let start = today;
  const days = 14;
  if (tlEnd) {
    const end = typeof tlEnd === 'string' ? tlEnd : fmtISO(tlEnd);
    const lastStart = addD(end, -(days - 1));
    if (fmtISO(start) > fmtISO(lastStart)) start = lastStart;
  }
  return { start: fmtISO(start), days };
}

export function teamAssigneeMap(
  snapshot: TeamSnapshot | null | undefined,
): AssigneeMap {
  return snapshot?.team.assigneeMap || {};
}

export {
  ROADMAP_CREATE_JIRA_SYSTEM_PROMPT,
  buildAgentCreatePrompt,
} from './useCreateJiraAgentPrompt';
