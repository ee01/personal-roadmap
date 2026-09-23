export const DRAFT_PLAN_SCHEMA_VERSION = '1' as const;
export const PLANNING_CONTRACT_VERSION = '1.0.0';
export const PLANNING_PROMPT_VERSION = 'draft-plan-v1';
export const PLANNING_CLIENT_MIN_VERSION = 2;

export const PLANNING_LIMITS = {
  maxInputChars: 30_000,
  maxInputBytes: 128 * 1024,
  maxParents: 20,
  maxNodes: 100,
  maxTitleChars: 200,
  maxDescriptionChars: 2000,
  maxQuoteChars: 400,
  maxJobsGlobal: 4,
  maxJobsPerTeam: 1,
  queueWaitMs: 30_000,
  jobTimeoutMs: 120_000,
  providerTimeoutMs: 60_000,
  maxAttempts: 2,
  maxOutputTokens: 16_384,
  planTtlMs: 24 * 60 * 60 * 1000,
  sourceRetainMs: 24 * 60 * 60 * 1000,
  undoWindowMs: 24 * 60 * 60 * 1000,
  dailyTeamCalls: 40,
  dailyGlobalCalls: 200,
  dailyTeamTokens: 800_000,
  dailyGlobalTokens: 4_000_000,
  placeholderDays: 7,
} as const;

export type DraftPlanSchemaVersion = typeof DRAFT_PLAN_SCHEMA_VERSION;
export type OwnerResolution = 'explicit' | 'ambiguous' | 'unassigned' | 'legacy';
export type ScheduleBasis = 'explicit' | 'inferred' | 'missing';
export type ParentAction = 'create' | 'attach';
export type PlanningJobStatus =
  | 'queued'
  | 'generating'
  | 'validating'
  | 'ready'
  | 'needs_input'
  | 'committing'
  | 'committed'
  | 'failed'
  | 'cancelled';

export type PlanningIssueCode =
  | 'no_actionable_content'
  | 'ambiguous_parent'
  | 'schedule_parent'
  | 'description_overflow'
  | 'date_conflict'
  | 'dependency_cycle'
  | 'unknown_ref'
  | 'duplicate_batch'
  | 'configuration_changed'
  | 'input_too_large'
  | 'limit_exceeded'
  | 'invalid_plan'
  | 'evidence_mismatch'
  | 'provider_unconfigured'
  | 'provider_truncated'
  | 'provider_refused'
  | 'provider_invalid_json'
  | 'unauthorized'
  | 'version_conflict';

export interface DraftSchedule {
  start: string | null;
  end: string | null;
  basis: ScheduleBasis;
}

export interface DraftEvidence {
  sourceId: string;
  quote: string;
}

export interface DraftChildPlan {
  ref: string;
  title: string;
  description: string;
  ownerCandidates: string[];
  owner: string | null;
  schedule: DraftSchedule;
  dependsOnRefs: string[];
  evidence: DraftEvidence[];
}

export interface DraftParentPlan {
  ref: string;
  action: ParentAction;
  existingItemKey: string | null;
  title: string;
  description: string;
  children: DraftChildPlan[];
  schedule: DraftSchedule;
  evidence: DraftEvidence[];
}

export interface DraftGlobalContext {
  background: string;
  constraints: string[];
  milestones: Array<{ label: string; date: string | null; approximate: boolean }>;
  risks: string[];
}

export interface DraftPlanV1 {
  schemaVersion: DraftPlanSchemaVersion;
  documentTitle: string;
  globalContext: DraftGlobalContext;
  parents: DraftParentPlan[];
  assumptions: Array<{ ref: string; field: string; reason: string }>;
}

export interface PlanningSource {
  id: string;
  title: string;
  text: string;
}

export interface ParentSelection {
  itemKeys: string[];
}

export interface PlanningIssue {
  code: PlanningIssueCode;
  severity: 'error' | 'warning' | 'decision';
  message: string;
  ref?: string;
  decisionId?: string;
  options?: Array<{ id: string; label: string }>;
}

export interface ParentPatch {
  itemKey: string;
  baseVersion: number;
  field: 'description' | 'schedule';
  before: unknown;
  after: unknown;
  reason: string;
  decisionId: string;
}

export interface OwnerResolutionResult {
  ref: string;
  owner: string | null;
  ownerCandidates: string[];
  resolution: Exclude<OwnerResolution, 'legacy'>;
  createdMember?: boolean;
}

export interface NormalizedNodeSchedule {
  start: string;
  days: number;
  end: string;
  basis: ScheduleBasis;
  scheduled: boolean;
  writeTargetDates: boolean;
  targetStart: string | null;
  targetEnd: string | null;
}

export interface NormalizedChild {
  ref: string;
  title: string;
  description: string;
  owner: string | null;
  ownerCandidates: string[];
  ownerResolution: Exclude<OwnerResolution, 'legacy'>;
  schedule: NormalizedNodeSchedule;
  dependsOnRefs: string[];
  evidence: DraftEvidence[];
}

export interface NormalizedParent {
  ref: string;
  action: ParentAction;
  existingItemKey: string | null;
  title: string;
  description: string;
  schedule: NormalizedNodeSchedule;
  children: NormalizedChild[];
  evidence: DraftEvidence[];
  parentPatches: ParentPatch[];
  scheduleParent: boolean;
}

export interface NormalizedDraftPlan {
  planId: string;
  revision: number;
  hash: string;
  schemaVersion: DraftPlanSchemaVersion;
  documentTitle: string;
  globalContext: DraftGlobalContext;
  parents: NormalizedParent[];
  assumptions: Array<{ ref: string; field: string; reason: string }>;
  ownerResolution: OwnerResolutionResult[];
  warnings: PlanningIssue[];
  issues: PlanningIssue[];
  contextFingerprint: string;
}

export interface BatchReceipt {
  batchId: string;
  requestId: string;
  planId: string;
  revision: number;
  createdParents: string[];
  attachedParents: string[];
  createdChildren: string[];
  refMappings: Record<string, { itemKey?: string; subId?: string }>;
  warnings: PlanningIssue[];
  assumptions: Array<{ ref: string; field: string; reason: string }>;
  roadmapUrl: string;
  committedAt: number;
  jiraCreated: false;
  undone?: boolean;
}

export interface PlanningCapabilities {
  contractVersion: string;
  schemaVersion: DraftPlanSchemaVersion;
  compatibleContractRange: string[];
  limits: typeof PLANNING_LIMITS;
  features: {
    serverLlm: boolean;
    autoCommit: boolean;
    undo: boolean;
    agentAccess: boolean;
  };
  providerDisplayName: string | null;
  endpointDisplayName: string | null;
  configurationVersion: string | null;
  autoCommitEligible: boolean;
  planningClientMinVersion: number;
}

export const FORBIDDEN_PLAN_KEYS = [
  'teamId',
  'jiraKey',
  'jira_key',
  'source',
  'sql',
  'intent',
  'shareToken',
  'token',
  'apiKey',
] as const;
