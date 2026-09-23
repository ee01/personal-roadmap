export type ActorSource = 'creator' | 'extension' | 'anonymous' | 'system' | 'web_ai' | 'agent';

/** Persisted per-team release-train ruler config (shared via snapshot). */
export interface ReleaseFilter {
  mode: 'all' | 'major' | 'custom';
  pattern: string;
}

export interface ReleaseSheetConfig {
  url: string;
  spreadsheetId: string;
  sheetName: string;
  range: string;
  /** Normalized phase kind used as Sprint split anchor (e.g. 'ff'). */
  splitPhase: string;
  /** Normalized phase kinds drawn on the ruler; always includes splitPhase (end handoff). */
  showPhases: string[];
  /** Keep/drop rules for release names on the ruler. */
  releaseFilter?: ReleaseFilter | null;
  /** Cached Apps Script rows; clients may refresh when stale. */
  rows: Array<Record<string, unknown>>;
  /** ISO timestamp of last successful fetch. */
  fetchedAt: string | null;
}

export type IntentOp =
  | 'create_team'
  | 'update_jql'
  | 'update_release_sheet'
  | 'import'
  | 'schedule'
  | 'unschedule'
  | 'move'
  | 'resize'
  | 'set_alias'
  | 'update_item'
  | 'expand'
  | 'collapse'
  | 'add_item'
  | 'delete_item'
  | 'resolve_item'
  | 'add_sub'
  | 'update_sub'
  | 'delete_sub'
  | 'resolve_draft'
  | 'cleanup'
  | 'add_member'
  | 'update_member'
  | 'remove_member'
  | 'add_marker'
  | 'update_marker'
  | 'delete_marker'
  | 'lock'
  | 'unlock'
  | 'set_quarters'
  | 'update_create_jira_prompt'
  | 'update_assignee_map'
  | 'merge_people'
  | 'refresh_from_jira'
  | 'defer_subs';

export type MarkerKind = 'phase' | 'dep';
export type PhaseKind = 'design' | 'stage' | 'production' | 'custom';
export type EtaSource = 'jira' | 'manual';

export interface MarkerRow {
  id: string;
  team_id: string;
  item_key: string;
  kind: MarkerKind;
  phase_kind: PhaseKind | null;
  label: string;
  date: string | null;
  jira_key: string | null;
  eta_source: EtaSource | null;
  jira_status: string | null;
  jira_target_end: string | null;
  jira_fetched_at: number | null;
  created_by: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface TeamRow {
  id: string;
  name: string;
  jql: string;
  checked_quarters_json: string;
  imported_quarters_json: string;
  release_sheet_json: string;
  create_jira_prompt: string;
  assignee_map_json: string;
  jira_refreshed_at: number | null;
  version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** Where an item came from: a Jira import, or created by hand in the Backlog. */
export type ItemSource = 'jira' | 'manual';

/**
 * Hierarchy hints derived from the team JQL (see `core/JqlIntrospect.ts`).
 * `confident: false` means we fell back to a guess and the UI must ask the user.
 */
export interface JqlHints {
  projectKey: string | null;
  itemType: string | null;
  subType: string | null;
  /** 'customfield_15751' (Parent Link) | 'customfield_11450' (Epic Link) | 'parent' */
  linkField: string | null;
  confident: boolean;
}

export interface ItemRow {
  id: string;
  team_id: string;
  key: string;
  type: string;
  title: string;
  alias: string | null;
  quarter: string | null;
  estimate: number | null;
  target_start: string | null;
  target_end: string | null;
  scheduled: number;
  start_date: string | null;
  days: number | null;
  lane: number;
  expanded: number;
  source: ItemSource;
  jira_key: string | null;
  project_key: string | null;
  description: string | null;
  /** Mirrored Jira workflow status (e.g. 'Closed', 'Resolved'); null until first Jira refresh. */
  status: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface SubRow {
  id: string;
  team_id: string;
  item_key: string;
  jira_key: string | null;
  title: string;
  alias: string | null;
  owner: string | null;
  start_date: string | null;
  days: number | null;
  /** Last mirrored Jira Target Start (confirm / refresh / import). */
  target_start: string | null;
  /** Last mirrored Jira Target End (confirm / refresh / import). */
  target_end: string | null;
  is_draft: number;
  /** 1 = hidden from Gantt/Resource after cleanup; restored when Epic is re-scheduled. */
  cleared: number;
  created_by: string;
  description: string | null;
  /** Mirrored Jira workflow status (e.g. 'Closed', 'Resolved'); null until first Jira refresh. */
  status: string | null;
  /** Mirrored Jira Original Estimate, ceiled to 8h man-days; null if empty. */
  original_estimate_days: number | null;
  owner_resolution: 'explicit' | 'ambiguous' | 'unassigned' | 'legacy';
  version: number;
  created_at: number;
  updated_at: number;
}

export interface MemberRow {
  id: string;
  team_id: string;
  name: string;
  avatar_color: string;
  created_at: number;
}

export interface ActivityRow {
  id: string;
  team_id: string;
  at: number;
  actor_name: string;
  actor_client_id: string;
  actor_source: ActorSource;
  op: string;
  target_type: string;
  target_key: string | null;
  summary_json: string;
  share_token_id: string | null;
  ip: string | null;
}

export interface ActorContext {
  name: string;
  clientId: string;
  source: ActorSource;
  shareTokenId?: string | null;
  ip?: string | null;
}

export interface TeamSnapshot {
  team: {
    id: string;
    name: string;
    jql: string;
    checkedQuarters: string[];
    importedQuarters: string[];
    version: number;
    createdBy: string;
    jqlHints: JqlHints;
    /** Server can talk to Jira (PAT configured) for Target sync / import Tasks. */
    jiraEnabled?: boolean;
    /** Team-shared release-train ruler; null = month ruler. */
    releaseSheet?: ReleaseSheetConfig | null;
    /** Team-shared Create-Jira Agent prompt. */
    createJiraPrompt?: string;
    /** System name (lowercase key) → Jira Firstname Lastname. */
    assigneeMap?: Record<string, string>;
    /** Browse base from server env (no trailing slash); may be empty. */
    jiraBaseUrl?: string;
    /** Epoch ms of last successful `refresh_from_jira`; used for 10-minute TTL. */
    jiraRefreshedAt?: number | null;
  };
  items: Array<{
    key: string;
    type: string;
    title: string;
    source: ItemSource;
    /** Real Jira key. Null only for manual items that have no Jira issue yet. */
    jiraKey: string | null;
    projectKey: string | null;
    alias?: string | null;
    quarter?: string | null;
    estimate?: number | null;
    targetStart?: string | null;
    targetEnd?: string | null;
    scheduled: boolean;
    start?: string | null;
    days?: number | null;
    lane: number;
    expanded: boolean;
    version: number;
    /** Epoch ms the row was inserted; Backlog uses it to float new manual rows. */
    createdAt: number;
    /** Draft user text, or Jira description mirror for non-draft rows. */
    description?: string | null;
    /** Mirrored Jira workflow status (e.g. 'Closed', 'Resolved'); null until first Jira refresh. */
    status?: string | null;
    subs: Array<{
      id: string;
      key?: string | null;
      title: string;
      alias?: string | null;
      owner?: string | null;
      start?: string | null;
      days?: number | null;
      targetStart?: string | null;
      targetEnd?: string | null;
      temp: boolean;
      cleared?: boolean;
      createdBy: string;
      version: number;
      description?: string | null;
      status?: string | null;
      originalEstimateDays?: number | null;
      ownerResolution?: 'explicit' | 'ambiguous' | 'unassigned' | 'legacy';
    }>;
    markers: Array<{
      id: string;
      kind: MarkerKind;
      phaseKind?: PhaseKind | null;
      label: string;
      date?: string | null;
      jiraKey?: string | null;
      etaSource?: EtaSource | null;
      createdBy: string;
      version: number;
    }>;
  }>;
  members: Array<{ id: string; name: string; avatarColor: string }>;
  presence: Array<{
    clientId: string;
    name: string;
    source: ActorSource;
    lastSeen: number;
  }>;
  locks: Array<{
    targetType: string;
    targetKey: string;
    actorName: string;
    actorClientId: string;
    expiresAt: number;
  }>;
}
