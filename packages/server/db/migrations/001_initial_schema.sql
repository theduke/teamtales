PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  primary_email TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, user_id)
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('personal_access_token', 'github_app', 'linear_oauth', 'linear_app')),
  status TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id)
);

CREATE TABLE integration_credentials (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  secret_hint TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sync_scopes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  scope_type TEXT NOT NULL,
  external_id TEXT,
  external_name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_success_at TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  FOREIGN KEY (integration_id, organization_id) REFERENCES integrations(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE sync_cursors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  sync_scope_id TEXT NOT NULL REFERENCES sync_scopes(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  object_type TEXT NOT NULL,
  cursor_kind TEXT NOT NULL,
  cursor_value TEXT,
  high_watermark TEXT,
  last_success_at TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (sync_scope_id, object_type, cursor_kind),
  FOREIGN KEY (integration_id, organization_id) REFERENCES integrations(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (sync_scope_id, organization_id) REFERENCES sync_scopes(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  sync_scope_id TEXT REFERENCES sync_scopes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  run_type TEXT NOT NULL CHECK (run_type IN ('initial_sync', 'incremental_sync', 'webhook_sync', 'manual_resync', 'repair_sync', 'reconciliation_sync')),
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  objects_fetched INTEGER NOT NULL DEFAULT 0 CHECK (objects_fetched >= 0),
  objects_inserted INTEGER NOT NULL DEFAULT 0 CHECK (objects_inserted >= 0),
  objects_updated INTEGER NOT NULL DEFAULT 0 CHECK (objects_updated >= 0),
  objects_unchanged INTEGER NOT NULL DEFAULT 0 CHECK (objects_unchanged >= 0),
  objects_failed INTEGER NOT NULL DEFAULT 0 CHECK (objects_failed >= 0),
  activity_events_emitted INTEGER NOT NULL DEFAULT 0 CHECK (activity_events_emitted >= 0),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  FOREIGN KEY (integration_id, organization_id) REFERENCES integrations(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (sync_scope_id, organization_id) REFERENCES sync_scopes(id, organization_id)
);

CREATE TABLE sync_run_items (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  external_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('inserted', 'updated', 'unchanged', 'deleted', 'inaccessible', 'skipped', 'failed')),
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_objects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  sync_scope_id TEXT REFERENCES sync_scopes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  object_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_url TEXT,
  external_created_at TEXT,
  external_updated_at TEXT,
  external_deleted_at TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  source_state TEXT NOT NULL CHECK (source_state IN ('active', 'deleted', 'inaccessible', 'error')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, provider, object_type, external_id),
  FOREIGN KEY (integration_id, organization_id) REFERENCES integrations(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (sync_scope_id, organization_id) REFERENCES sync_scopes(id, organization_id)
);

CREATE TABLE source_object_versions (
  id TEXT PRIMARY KEY,
  source_object_id TEXT NOT NULL REFERENCES source_objects(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  seen_at TEXT NOT NULL,
  change_reason TEXT
);

CREATE TABLE source_webhook_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  event_type TEXT NOT NULL,
  external_delivery_id TEXT,
  signature_valid INTEGER NOT NULL CHECK (signature_valid IN (0, 1)),
  raw_headers_json TEXT NOT NULL CHECK (json_valid(raw_headers_json)),
  raw_body_json TEXT NOT NULL CHECK (json_valid(raw_body_json)),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (integration_id, organization_id) REFERENCES integrations(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  primary_email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id)
);

CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  external_id TEXT NOT NULL,
  external_username TEXT,
  external_email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, provider, external_id),
  FOREIGN KEY (person_id, organization_id) REFERENCES people(id, organization_id)
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_object_id TEXT REFERENCES source_objects(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  source_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT,
  status TEXT NOT NULL,
  work_type TEXT NOT NULL CHECK (work_type IN ('github_pull_request', 'github_issue', 'linear_issue', 'linear_project')),
  created_at_source TEXT,
  updated_at_source TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, provider, source_type, external_id),
  FOREIGN KEY (source_object_id, organization_id) REFERENCES source_objects(id, organization_id)
);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_object_id TEXT REFERENCES source_objects(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  event_type TEXT NOT NULL,
  actor_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  repository_id TEXT,
  linear_team_id TEXT,
  linear_project_id TEXT,
  occurred_at TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_object_id, organization_id) REFERENCES source_objects(id, organization_id),
  FOREIGN KEY (actor_person_id, organization_id) REFERENCES people(id, organization_id),
  FOREIGN KEY (work_item_id, organization_id) REFERENCES work_items(id, organization_id)
);

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id)
);

CREATE TABLE analysis_metrics (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  dimensions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dimensions_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (analysis_run_id, organization_id) REFERENCES analysis_runs(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE analysis_highlights (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  highlight_type TEXT NOT NULL CHECK (highlight_type IN ('completed_work', 'merged_pr', 'active_discussion', 'cross_team_collaboration', 'project_progress', 'potential_blocker', 'long_running_item_completed')),
  score REAL NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (analysis_run_id, organization_id) REFERENCES analysis_runs(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id, organization_id) REFERENCES work_items(id, organization_id)
);

CREATE TABLE analysis_report_contexts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  FOREIGN KEY (analysis_run_id, organization_id) REFERENCES analysis_runs(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL CHECK (run_type IN ('weekly_report', 'monthly_report', 'quarterly_report', 'comic_script', 'movie_script', 'fact_check', 'edit')),
  status TEXT NOT NULL,
  model TEXT,
  input_ref_type TEXT NOT NULL,
  input_ref_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id)
);

CREATE TABLE ai_run_steps (
  id TEXT PRIMARY KEY,
  ai_run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json)),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  analysis_report_context_id TEXT NOT NULL REFERENCES analysis_report_contexts(id) ON DELETE RESTRICT,
  report_type TEXT NOT NULL CHECK (report_type IN ('weekly', 'monthly', 'quarterly', 'custom')),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body_markdown TEXT NOT NULL,
  structured_json TEXT NOT NULL CHECK (json_valid(structured_json)),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  FOREIGN KEY (analysis_report_context_id, organization_id) REFERENCES analysis_report_contexts(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE report_inputs (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  input_type TEXT NOT NULL CHECK (input_type IN ('analysis_report_context', 'analysis_metric', 'analysis_highlight', 'activity_event', 'work_item', 'source_object', 'previous_report')),
  input_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE report_artifacts (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('comic_script', 'comic_panels', 'movie_script', 'storyboard', 'slack_update', 'email_update', 'executive_summary')),
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body_markdown TEXT,
  structured_json TEXT CHECK (structured_json IS NULL OR json_valid(structured_json)),
  asset_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE report_links (
  id TEXT PRIMARY KEY,
  parent_report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  child_report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (parent_report_id, child_report_id, link_type),
  CHECK (parent_report_id <> child_report_id)
);

CREATE INDEX idx_integrations_organization_provider ON integrations (organization_id, provider);
CREATE INDEX idx_sync_scopes_integration ON sync_scopes (integration_id, provider, enabled);
CREATE INDEX idx_sync_cursors_scope_object ON sync_cursors (sync_scope_id, object_type, cursor_kind);
CREATE INDEX idx_sync_runs_scope_started ON sync_runs (sync_scope_id, started_at);
CREATE INDEX idx_source_objects_scope_type ON source_objects (sync_scope_id, object_type);
CREATE INDEX idx_source_objects_updated ON source_objects (provider, object_type, external_updated_at);
CREATE INDEX idx_source_webhook_events_delivery ON source_webhook_events (provider, external_delivery_id);
CREATE INDEX idx_external_identities_person ON external_identities (person_id);
CREATE INDEX idx_work_items_period ON work_items (organization_id, provider, work_type, updated_at_source);
CREATE INDEX idx_activity_events_period ON activity_events (organization_id, occurred_at);
CREATE INDEX idx_activity_events_work_item ON activity_events (work_item_id, occurred_at);
CREATE INDEX idx_analysis_runs_scope_period ON analysis_runs (organization_id, scope_type, scope_id, period_start, period_end);
CREATE INDEX idx_analysis_metrics_run_name ON analysis_metrics (analysis_run_id, metric_name);
CREATE INDEX idx_analysis_highlights_run_score ON analysis_highlights (analysis_run_id, score DESC);
CREATE INDEX idx_reports_scope_period ON reports (organization_id, scope_type, scope_id, period_start, period_end);
CREATE INDEX idx_report_inputs_report ON report_inputs (report_id, input_type);
CREATE INDEX idx_report_artifacts_report ON report_artifacts (report_id, artifact_type);
