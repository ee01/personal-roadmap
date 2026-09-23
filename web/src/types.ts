export type ActorSource = 'creator' | 'extension' | 'anonymous' | 'system';
export type ViewMode = 'gantt' | 'resource';
export type ResWindow = '2w' | 'all';
export type MarkerKind = 'phase' | 'dep';
export type PhaseKind = 'design' | 'stage' | 'production' | 'custom';
export type EtaSource = 'jira' | 'manual';
export type RulerMode = 'release' | 'month';
export type ReleaseFilterMode = 'all' | 'major' | 'custom';

export interface ReleaseFilter {
  mode: ReleaseFilterMode;
  pattern: string;
}

export interface ReleaseSheetConfig {
  url: string;
  spreadsheetId: string;
  sheetName: string;
  range: string;
  splitPhase: string;
  /** Phase kinds drawn on the ruler; always includes the end-split phase. */
  showPhases: string[];
  releaseFilter?: ReleaseFilter | null;
  rows: Array<Record<string, unknown>>;
  fetchedAt: string | null;
}

export interface TeamSummary {
  id: string;
  name: string;
  jql: string;
  checkedQuarters: string[];
  importedQuarters: string[];
  version: number;
}

/** Where an item came from: a Jira import, or created by hand in the Backlog. */
export type ItemSource = 'jira' | 'manual';

/**
 * Hierarchy hints the server derives from the team JQL.
 * `confident` only reflects `itemType`; `projectKey` can be null regardless.
 */
export interface JqlHints {
  projectKey: string | null;
  itemType: string | null;
  subType: string | null;
  linkField: string | null;
  confident: boolean;
}

export interface RoadmapMarker {
  id: string;
  kind: MarkerKind;
  phaseKind?: PhaseKind | null;
  label: string;
  date?: string | null;
  jiraKey?: string | null;
  etaSource?: EtaSource | null;
  /** Last mirrored Jira status name; null until a refresh has seen this key. */
  jiraStatus?: string | null;
  /** Last mirrored Jira Target End; never auto-copied onto `date`. */
  jiraTargetEnd?: string | null;
  jiraFetchedAt?: number | null;
  createdBy: string;
  version: number;
}

export interface RoadmapSub {
  id: string;
  key?: string | null;
  title: string;
  alias?: string | null;
  owner?: string | null;
  start?: string | null;
  days?: number | null;
  /** Last mirrored Jira Target Start; used to detect unsynced Gantt edits. */
  targetStart?: string | null;
  /** Last mirrored Jira Target End; used to detect unsynced Gantt edits. */
  targetEnd?: string | null;
  temp: boolean;
  /** Soft-hidden after cleanup; still counted in Backlog memory. */
  cleared?: boolean;
  createdBy: string;
  version: number;
  /** Draft user text, or Jira description mirror for imported tasks. */
  description?: string | null;
  /** Mirrored Jira workflow status (e.g. 'Closed', 'Resolved'); null until first Jira refresh. */
  status?: string | null;
  /** Mirrored Jira Original Estimate, ceiled to man-days; null if empty. */
  originalEstimateDays?: number | null;
  ownerResolution?: 'explicit' | 'ambiguous' | 'unassigned' | 'legacy';
}

export interface RoadmapItem {
  key: string;
  type: string;
  title: string;
  source: ItemSource;
  /** Real Jira key. Null only while no Jira issue exists for this item yet. */
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
  /** Epoch ms of row creation; absent when talking to an older server. */
  createdAt?: number;
  /** Draft user text, or Jira description mirror for non-draft items. */
  description?: string | null;
  /** Mirrored Jira workflow status (e.g. 'Closed', 'Resolved'); null until first Jira refresh. */
  status?: string | null;
  subs: RoadmapSub[];
  markers: RoadmapMarker[];
}

export interface TeamMember {
  id: string;
  name: string;
  avatarColor: string;
}

export interface PresenceEntry {
  clientId: string;
  name: string;
  source: ActorSource;
  lastSeen: number;
}

export interface LockEntry {
  targetType: string;
  targetKey: string;
  actorName: string;
  actorClientId: string;
  expiresAt: number;
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
    /** Team-shared release-train ruler; null/absent = month ruler. */
    releaseSheet?: ReleaseSheetConfig | null;
    /** Team-shared Create-Jira Agent prompt shown to all collaborators. */
    createJiraPrompt?: string;
    /** System name (lowercase key) → Jira Firstname Lastname. */
    assigneeMap?: Record<string, string>;
    /** Browse base from server env; empty when unset. */
    jiraBaseUrl?: string;
    /** Epoch ms of last successful Jira refresh; used for 10-minute TTL. */
    jiraRefreshedAt?: number | null;
  };
  items: RoadmapItem[];
  members: TeamMember[];
  presence: PresenceEntry[];
  locks: LockEntry[];
}

export interface ActivityEntry {
  id: string;
  teamId: string;
  at: number;
  actorName: string;
  actorClientId: string;
  actorSource: ActorSource;
  op: string;
  targetType: string;
  targetKey: string | null;
  summary: Record<string, unknown>;
  text: string;
}
