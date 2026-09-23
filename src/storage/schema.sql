-- Personal Roadmap schema
CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  jql TEXT NOT NULL DEFAULT '',
  checked_quarters_json TEXT NOT NULL DEFAULT '[]',
  imported_quarters_json TEXT NOT NULL DEFAULT '[]',
  release_sheet_json TEXT NOT NULL DEFAULT 'null',
  create_jira_prompt TEXT NOT NULL DEFAULT '',
  assignee_map_json TEXT NOT NULL DEFAULT '{}',
  jira_refreshed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Epic',
  title TEXT NOT NULL,
  alias TEXT,
  quarter TEXT,
  estimate REAL,
  target_start TEXT,
  target_end TEXT,
  scheduled INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  days INTEGER,
  lane INTEGER NOT NULL DEFAULT 0,
  expanded INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'jira',
  jira_key TEXT,
  project_key TEXT,
  description TEXT,
  status TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, key),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_team ON items(team_id);
CREATE INDEX IF NOT EXISTS idx_items_scheduled ON items(team_id, scheduled);
-- idx_items_jira_key is created by migration 003 instead: this file is executed
-- before the migrations run, so it must not reference columns that an existing
-- deployment has not been migrated to yet.

CREATE TABLE IF NOT EXISTS subs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  jira_key TEXT,
  title TEXT NOT NULL,
  alias TEXT,
  owner TEXT,
  start_date TEXT,
  days INTEGER,
  target_start TEXT,
  target_end TEXT,
  is_draft INTEGER NOT NULL DEFAULT 1,
  cleared INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  description TEXT,
  status TEXT,
  original_estimate_days INTEGER,
  owner_resolution TEXT NOT NULL DEFAULT 'legacy',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subs_team_item ON subs(team_id, item_key);

CREATE TABLE IF NOT EXISTS item_markers (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase_kind TEXT,
  label TEXT NOT NULL,
  date TEXT,
  jira_key TEXT,
  eta_source TEXT,
  jira_status TEXT,
  jira_target_end TEXT,
  jira_fetched_at INTEGER,
  created_by TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_markers_team_item ON item_markers(team_id, item_key);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#5B8DEF',
  created_at INTEGER NOT NULL,
  UNIQUE(team_id, name),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS share_tokens (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_team ON share_tokens(team_id);

CREATE TABLE IF NOT EXISTS soft_locks (
  team_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_client_id TEXT NOT NULL,
  locked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, target_type, target_key),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  actor_client_id TEXT NOT NULL,
  actor_source TEXT NOT NULL DEFAULT 'anonymous',
  op TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_key TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  share_token_id TEXT,
  ip TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_log_team_at ON activity_log(team_id, at DESC);

CREATE TABLE IF NOT EXISTS presence (
  team_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'anonymous',
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (team_id, client_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_planning_requests (
  team_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_kind TEXT NOT NULL,
  result_id TEXT,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, operation, request_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_planning_jobs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL,
  auto_commit INTEGER NOT NULL DEFAULT 1,
  configuration_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  endpoint_display TEXT,
  lease_until INTEGER,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  plan_id TEXT,
  batch_id TEXT,
  error_code TEXT,
  error_message TEXT,
  source_json TEXT,
  source_hash TEXT NOT NULL,
  options_json TEXT NOT NULL,
  usage_json TEXT,
  issues_json TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_draft_jobs_team_status
  ON draft_planning_jobs(team_id, status, queued_at);

CREATE TABLE IF NOT EXISTS draft_plans (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  source_json TEXT,
  source_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  context_fingerprint TEXT NOT NULL DEFAULT '',
  committed_batch_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (id, revision),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_draft_plans_team ON draft_plans(team_id, id);

CREATE TABLE IF NOT EXISTS draft_batches (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  status TEXT NOT NULL,
  undo_until INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  UNIQUE(team_id, plan_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_batch_rows (
  batch_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_key TEXT,
  sub_id TEXT,
  existing INTEGER NOT NULL DEFAULT 0,
  written_version INTEGER,
  handoff_state TEXT,
  snapshot_json TEXT,
  PRIMARY KEY (batch_id, ref)
);

CREATE TABLE IF NOT EXISTS draft_llm_usage (
  day TEXT NOT NULL,
  team_id TEXT NOT NULL DEFAULT '',
  calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  reserved_calls INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, team_id)
);
