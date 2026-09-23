import { config } from '../config.js';
import type { JqlHints } from '../types.js';
import {
  EPIC_LINK_FIELD,
  PARENT_FIELD,
  PARENT_LINK_FIELD,
} from './JqlIntrospect.js';
import { originalEstimateFromJiraFields } from './originalEstimate.js';

export class JiraHttpError extends Error {
  status: number;
  bodySnippet: string;

  constructor(status: number, bodySnippet: string) {
    super(`Jira HTTP ${status}: ${bodySnippet}`);
    this.name = 'JiraHttpError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

export interface RemoteTask {
  key: string;
  summary: string;
  epicKey: string;
  targetStart: string | null;
  targetEnd: string | null;
  assignee: string | null;
  originalEstimateDays?: number | null;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.jira.pat}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function baseUrl(): string {
  return config.jira.baseUrl.replace(/\/$/, '');
}

async function jiraFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!config.jira.enabled) {
    throw new JiraHttpError(501, 'jira_not_configured');
  }
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new JiraHttpError(res.status, text.slice(0, 400));
  }
  return res;
}

/** ISO date → ISO date + (days) calendar days (UTC-safe for YYYY-MM-DD). */
export function addIsoDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export async function jiraUpdateTargetDates(
  key: string,
  start: string,
  end: string,
): Promise<void> {
  const fields: Record<string, string> = {
    [config.jira.fieldTargetStart]: start,
    [config.jira.fieldTargetEnd]: end,
  };
  await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });
}

function linkClause(linkField: string | null, epicKeys: string[]): string {
  const quoted = epicKeys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(', ');
  if (linkField === PARENT_LINK_FIELD) {
    return `"Parent Link" in (${quoted})`;
  }
  if (linkField === PARENT_FIELD) {
    return `parent in (${quoted})`;
  }
  // Default / Epic Link
  if (linkField === EPIC_LINK_FIELD || !linkField) {
    return `"Epic Link" in (${quoted})`;
  }
  // Unknown custom field id — use cf[NNNNN] form
  const cf = /^customfield_(\d+)$/.exec(linkField);
  if (cf) return `cf[${cf[1]}] in (${quoted})`;
  return `"Epic Link" in (${quoted})`;
}

function toIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  return null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Search Tasks linked to the given parent keys (Epic / Initiative / Task).
 * Paginates like the extension import path (startAt + maxResults).
 */
export async function jiraSearchChildTasks(
  epicKeys: string[],
  hints: JqlHints,
): Promise<RemoteTask[]> {
  const unique = [...new Set(epicKeys.map((k) => k.trim()).filter(Boolean))];
  if (!unique.length) return [];

  const fields = [
    'summary',
    'issuetype',
    'assignee',
    'timeoriginalestimate',
    config.jira.fieldTargetStart,
    config.jira.fieldTargetEnd,
    'parent',
    EPIC_LINK_FIELD,
    PARENT_LINK_FIELD,
  ].join(',');

  const results: RemoteTask[] = [];

  for (const group of chunk(unique, 40)) {
    const jql =
      `${linkClause(hints.linkField, group)} ` +
      `AND issuetype = Task AND status not in (Cancelled, Closed) ` +
      `ORDER BY key ASC`;

    let startAt = 0;
    const maxResults = 100;
    for (;;) {
      const res = await jiraFetch('/rest/api/2/search', {
        method: 'POST',
        body: JSON.stringify({ jql, startAt, maxResults, fields: fields.split(',') }),
      });
      const data = (await res.json()) as {
        startAt: number;
        maxResults: number;
        total: number;
        issues: Array<{
          key: string;
          fields?: Record<string, unknown>;
        }>;
      };

      for (const issue of data.issues || []) {
        const f = issue.fields || {};
        const epicKey = resolveParentKey(f, group) || group[0];
        const assignee = f.assignee as { displayName?: string } | null;
        results.push({
          key: issue.key,
          summary: String(f.summary || issue.key),
          epicKey,
          targetStart: toIsoDate(f[config.jira.fieldTargetStart]),
          targetEnd: toIsoDate(f[config.jira.fieldTargetEnd]),
          assignee: assignee?.displayName?.trim() || null,
          originalEstimateDays: originalEstimateFromJiraFields(f),
        });
      }

      startAt += data.maxResults || maxResults;
      if (startAt >= (data.total || 0) || !(data.issues || []).length) break;
    }
  }

  return results;
}

function resolveParentKey(
  fields: Record<string, unknown>,
  candidates: string[],
): string | null {
  const set = new Set(candidates);
  const parent = fields.parent as { key?: string } | null;
  if (parent?.key && set.has(parent.key)) return parent.key;
  const epicLink = fields[EPIC_LINK_FIELD];
  if (typeof epicLink === 'string' && set.has(epicLink)) return epicLink;
  if (epicLink && typeof epicLink === 'object' && 'key' in epicLink) {
    const key = String((epicLink as { key?: string }).key || '');
    if (set.has(key)) return key;
  }
  const parentLink = fields[PARENT_LINK_FIELD];
  if (typeof parentLink === 'string' && set.has(parentLink)) return parentLink;
  return null;
}
