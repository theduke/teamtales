# TeamTales Plan Update — Data Ingestion, Analysis, and AI Summary Generation

## 1. Data Ingestion Architecture

TeamTales should have a dedicated dto a local database.

Avoid naming this layer “mirroring” in the schema. The concept is useful architecturally, but table names should describe what the data actually represents.

Use these naming groups:

```txt
integrations_*  -> configured external systems and credentials
sync_*          -> operational sync state, cursors, runs, failures
source_*        -> raw imported external objects
work_*          -> normalized work entities
activity_*      -> normalized activity timeline
analysis_*      -> derived metrics, rollups, and report contexts
report_*        -> generated reports and report artifacts
ai_* / agent_*  -> AI and agent execution records
```

## 2. Integration Tables

### `integrations`

Represents a connected external provider.

Fields:

```txt
id
organization_id
provider
auth_type
status
display_name
created_at
updated_at
```

Provider values:

```txt
github
linear
```

Auth types:

```txt
personal_access_token
github_app
linear_oauth
linear_app
```

The MVP should support:

```txt
github + personal_access_token
linear + personal_access_token
```

The schema should already allow future GitHub App and Linear OAuth/App integrations.

### `integration_credentials`

Stores encrypted credentials.

Fields:

```txt
id
integration_id
encrypted_secret
secret_hint
expires_at
created_at
updated_at
```

Rules:

- never store plaintext tokens
- never log tokens
- decrypt only inside connector execution
- support credential rotation
- store token hints only for UI/debugging

## 3. Sync Operational Tables

### `sync_scopes`

Represents the unit being synced.

Examples:

- GitHub repository
- GitHub organization, later
- Linear workspace
- Linear team
- Linear project

Fields:

```txt
id
organization_id
integration_id
provider
scope_type
external_id
external_name
config_json
enabled
last_success_at
last_attempt_at
created_at
updated_at
```

Example GitHub scope:

```json
{
  "provider": "github",
  "scope_type": "repository",
  "external_name": "wasmerio/wasmer"
}
```

Example Linear scope:

```json
{
  "provider": "linear",
  "scope_type": "workspace",
  "external_name": "Wasmer"
}
```

### `sync_cursors`

Tracks incremental sync progress.

Fields:

```txt
id
organization_id
integration_id
sync_scope_id
provider
object_type
cursor_kind
cursor_value
high_watermark
last_success_at
last_attempt_at
created_at
updated_at
```

Example cursor rows:

```txt
github.pull_request.updated_at
github.pull_request_review.updated_at
github.issue_comment.updated_at
linear.issue.updated_at
linear.comment.updated_at
linear.project.updated_at
```

Use multiple cursors per scope.

Do not use one global cursor per integration. Different object types need different sync strategies.

### `sync_runs`

Represents one sync execution.

Fields:

```txt
id
organization_id
integration_id
sync_scope_id
provider
run_type
status
started_at
finished_at
objects_fetched
objects_inserted
objects_updated
objects_unchanged
objects_failed
activity_events_emitted
error
created_at
```

Run types:

```txt
initial_sync
incremental_sync
webhook_sync
manual_resync
repair_sync
reconciliation_sync
```

### `sync_run_items`

Optional but useful for debugging.

Fields:

```txt
id
sync_run_id
object_type
external_id
action
status
error
created_at
```

Actions:

```txt
inserted
updated
unchanged
deleted
inaccessible
skipped
failed
```

## 4. Source Data Tables

### `source_objects`

Stores raw imported provider objects.

This is the local source-of-truth copy of GitHub and Linear objects.

Fields:

```txt
id
organization_id
integration_id
sync_scope_id
provider
object_type
external_id
external_url
external_created_at
external_updated_at
external_deleted_at
raw_json
content_hash
first_seen_at
last_seen_at
last_changed_at
source_state
created_at
updated_at
```

Object types:

```txt
github.repository
github.pull_request
github.pull_request_review
github.pull_request_comment
github.issue
github.issue_comment
github.commit
github.user

linear.workspace
linear.team
linear.project
linear.issue
linear.comment
linear.user
linear.label
linear.workflow_state
```

Source states:

```txt
active
deleted
inaccessible
error
```

Important rule:

```txt
Do not hard-delete source objects during normal sync.
```

If an object becomes unavailable, mark it as `inaccessible` or `deleted`.

### `source_object_versions`

Optional after MVP.

Stores historic versions of changed source objects.

Fields:

```txt
id
source_object_id
content_hash
raw_json
seen_at
change_reason
```

This allows later “what changed over time?” analysis.

For MVP, you can skip this and only keep the latest `raw_json` in `source_objects`.

### `source_webhook_events`

Stores raw webhook payloads.

Fields:

```txt
id
organization_id
integration_id
provider
event_type
external_delivery_id
signature_valid
raw_headers_json
raw_body_json
received_at
processed_at
status
error
created_at
```

This gives you replayability.

Webhook handling flow:

```txt
receive webhook
verify signature
store source_webhook_events row
enqueue sync job
fetch full source object if needed
upsert source_objects
normalize changed object
emit activity_events
```

## 5. Source Object Change Detection

Every fetched provider object should be canonicalized and hashed.

Flow:

```txt
fetch provider object
canonicalize JSON
compute content_hash
look up source_objects row by provider + object_type + external_id
if missing -> insert
if hash changed -> update and mark changed
if hash same -> update last_seen_at only
```

This gives a clean separation between:

- object was fetched
- object changed
- object generated new normalized activity
- object affected a report

## 6. GitHub Ingestion

## 6.1 MVP Scope

Start with explicitly configured repositories.

Example config:

```json
{
  "repositories": ["org/repo-a", "org/repo-b"]
}
```

Each repository becomes a `sync_scopes` row.

## 6.2 GitHub Objects to Import

MVP:

```txt
repository
pull_request
pull_request_review
pull_request_comment
issue
issue_comment
commit
user
```

## 6.3 GitHub Sync Flow

For each enabled GitHub repository scope:

```txt
load GitHub token
load sync cursor for pull requests
fetch PRs updated since cursor
for each PR:
  fetch PR details
  fetch reviews
  fetch review comments
  fetch issue comments
  optionally fetch commits
  upsert source_objects
  normalize PR into work_items
  emit activity_events
advance cursor after successful persistence
record sync_run
```

## 6.4 GitHub Activity Events

Emit normalized events such as:

```txt
github.pr_opened
github.pr_merged
github.pr_closed
github.pr_reopened
github.pr_reviewed
github.pr_review_commented
github.pr_commented
github.commit_authored
```

A GitHub PR should become a normalized `work_items` row.

Reviews, comments, merges, and commits should become `activity_events`.

## 7. Linear Ingestion

## 7.1 MVP Scope

Start with the workspace/team data available to the provided token.

Create sync scopes for:

```txt
linear workspace
linear teams
linear projects, optionally
```

## 7.2 Linear Objects to Import

MVP:

```txt
workspace
user
team
project
workflow_state
label
issue
comment
```

## 7.3 Linear Sync Flow

For each Linear integration:

```txt
load Linear token
fetch workspace metadata
fetch users
fetch teams
fetch projects updated since cursor
fetch issues updated since cursor
fetch comments updated since cursor
upsert source_objects
normalize issues/projects/teams
emit activity_events
advance cursors after successful persistence
record sync_run
```

## 7.4 Linear Activity Events

Emit normalized events such as:

```txt
linear.issue_created
linear.issue_updated
linear.issue_assigned
linear.issue_status_changed
linear.issue_completed
linear.issue_commented
linear.project_created
linear.project_updated
linear.project_completed
```

Important caveat:

Do not invent history.

If Linear only gives current state for a field and TeamTales did not observe the transition, do not claim an exact transition happened unless the source data supports it.

Use conservative wording:

```txt
Observed as completed during this period.
```

rather than:

```txt
Alice moved this issue from In Progress to Done on Tuesday.
```

unless that exact transition is known.

## 8. Normalized Work Tables

### `people`

Represents a human person in TeamTales.

Fields:

```txt
id
organization_id
display_name
primary_email
created_at
updated_at
```

### `external_identities`

Maps people to provider identities.

Fields:

```txt
id
organization_id
person_id
provider
external_id
external_username
external_email
display_name
created_at
updated_at
```

The same person may have:

```txt
GitHub username
Linear user id
company email
```

Do not assume identities match by display name.

### `work_items`

Normalized representation of things being worked on.

Fields:

```txt
id
organization_id
source_object_id
provider
source_type
external_id
title
description
url
status
work_type
created_at_source
updated_at_source
started_at
completed_at
created_at
updated_at
```

Work types:

```txt
github_pull_request
github_issue
linear_issue
linear_project
```

### `activity_events`

Normalized activity timeline.

Fields:

```txt
id
organization_id
source_object_id
provider
event_type
actor_person_id
work_item_id
repository_id
linear_team_id
linear_project_id
occurred_at
title
body
url
metadata_json
created_at
```

This is the main table used for reporting.

## 9. Analysis Layer

The analysis layer should turn raw activity into report-ready facts.

The analysis layer should be mostly deterministic.

AI should not be needed to count PRs, group work by project, or determine which issues were completed.

## 9.1 Analysis Responsibilities

The analysis layer should:

- group activity by timeframe
- group activity by person
- group activity by GitHub repository
- group activity by Linear team
- group activity by Linear project
- compute contribution/activity metrics
- select candidate highlights
- detect repeated themes
- detect possible risks or stale items
- build report contexts for AI generation

## 9.2 Analysis Tables

### `analysis_runs`

Represents one analysis execution.

Fields:

```txt
id
organization_id
scope_type
scope_id
period_start
period_end
status
started_at
finished_at
error
created_at
```

### `analysis_metrics`

Stores computed metrics for a scope and period.

Fields:

```txt
id
organization_id
analysis_run_id
scope_type
scope_id
period_start
period_end
metric_name
metric_value
dimensions_json
created_at
```

Example metrics:

```txt
github.prs_opened
github.prs_merged
github.prs_reviewed
github.pr_comments
linear.issues_created
linear.issues_completed
linear.issues_updated
linear.comments_created
people.active_contributors
```

### `analysis_highlights`

Stores selected highlight candidates.

Fields:

```txt
id
organization_id
analysis_run_id
work_item_id
highlight_type
score
title
reason
source_refs_json
created_at
```

Highlight types:

```txt
completed_work
merged_pr
active_discussion
cross_team_collaboration
project_progress
potential_blocker
long_running_item_completed
```

### `analysis_report_contexts`

Stores the complete factual context used to generate a report.

Fields:

```txt
id
organization_id
analysis_run_id
scope_type
scope_id
period_start
period_end
context_json
created_at
```

This is important because the AI report should be reproducible and auditable.

The generated report should point back to the exact `analysis_report_contexts` row that was used.

## 9.3 Analysis Pipeline

For a weekly organization report:

```txt
load activity_events for period
load related work_items
load related people
load related repositories
load related Linear teams/projects
compute metrics
score candidate highlights
detect risks/open threads
build report context JSON
save analysis_run
save analysis_metrics
save analysis_highlights
save analysis_report_contexts
```

## 9.4 Highlight Scoring

Start with deterministic scoring.

Example scoring signals:

```txt
+ completed during period
+ merged during period
+ many comments/reviews
+ linked to Linear project
+ touched by multiple people
+ long-running item completed
+ manually pinned by user
- tiny/low-signal maintenance task
- duplicate/noisy automated activity
```

The score should be explainable.

Example:

```json
{
  "score": 84,
  "reason": [
    "PR merged during this period",
    "Linked Linear issue was completed",
    "Reviewed by 3 people",
    "Part of project Edge Sync"
  ]
}
```

AI can later help classify themes, but the initial ranking should be deterministic.

## 10. Report Context

The report context is the contract between deterministic analysis and AI generation.

Example:

```ts
type ReportContext = {
  organization: {
    id: string;
    name: string;
  };
  scope: {
    type: "organization" | "person" | "github_repository" | "linear_team" | "linear_project";
    id: string;
    name: string;
  };
  period: {
    start: string;
    end: string;
  };
  freshness: {
    github?: string;
    linear?: string;
    warnings: string[];
  };
  metrics: {
    name: string;
    value: number;
    dimensions?: Record<string, unknown>;
  }[];
  highlights: {
    title: string;
    reason: string;
    sourceRefs: string[];
    relatedPeople: string[];
    relatedWorkItems: string[];
  }[];
  people: {
    personId: string;
    displayName: string;
    activitySummary: string;
    metrics: Record<string, number>;
    sourceRefs: string[];
  }[];
  workItems: {
    id: string;
    provider: string;
    title: string;
    url: string;
    status: string;
    summaryFacts: string[];
  }[];
  risks: {
    title: string;
    reason: string;
    sourceRefs: string[];
  }[];
};
```

The LLM should only receive this context, not raw unrestricted API access.

## 11. AI Summary Generation

AI generation should be a separate layer after ingestion and analysis.

The AI should write from verified report context.

Pipeline:

```txt
source_objects
  -> work_items + activity_events
  -> analysis_metrics + analysis_highlights
  -> analysis_report_contexts
  -> AI report generation
  -> fact check
  -> saved report
```

## 11.1 AI Execution Tables

### `ai_runs`

Tracks an AI generation run.

Fields:

```txt
id
organization_id
run_type
status
model
input_ref_type
input_ref_id
prompt_version
started_at
finished_at
error
created_at
```

Run types:

```txt
weekly_report
monthly_report
quarterly_report
comic_script
movie_script
fact_check
edit
```

### `ai_run_steps`

Tracks individual substeps.

Fields:

```txt
id
ai_run_id
step_name
status
input_json
output_json
error
started_at
finished_at
created_at
```

Example steps:

```txt
write_report_outline
write_report_sections
fact_check_report
edit_report
generate_comic_script
generate_movie_script
```

## 11.2 AI Report Generation Flow

For a weekly report:

```txt
create analysis_run
create analysis_report_context
create ai_run
call Report Writer Agent
validate structured output
call Fact Checker Agent
if fact check fails:
  call Repair/Editor Agent
validate again
save reports row
save report_inputs
save ai_run result
```

## 11.3 Report Writer Agent

Input:

```txt
analysis_report_contexts.context_json
tone
audience
report_type
```

Output:

```json
{
  "title": "...",
  "executiveSummary": "...",
  "sections": [
    {
      "heading": "...",
      "body": "...",
      "sourceRefs": ["activity_event:...", "work_item:..."]
    }
  ],
  "metricsSummary": "...",
  "risks": [],
  "markdown": "..."
}
```

Rules:

- do not invent people
- do not invent PRs
- do not invent Linear issues
- do not invent metrics
- cite source refs internally
- use cautious language for inferred themes
- distinguish facts from interpretation

## 11.4 Fact Checker Agent

The Fact Checker Agent compares generated text against the report context.

It should flag:

```txt
unsupported claim
wrong metric
wrong date
unknown person
unknown project
unknown repository
unknown issue
unknown PR
overconfident causal claim
```

Output:

```json
{
  "status": "pass",
  "issues": []
}
```

or:

```json
{
  "status": "fail",
  "issues": [
    {
      "claim": "The team completed the billing migration.",
      "problem": "No completed billing migration appears in the report context.",
      "severity": "high"
    }
  ]
}
```

## 11.5 Editor Agent

The Editor Agent improves readability after fact checking.

It should not add new facts.

Allowed:

- improve wording
- shorten
- make tone more cheerful
- improve structure
- remove unsupported claims

Not allowed:

- add new metrics
- add new people
- add new issues
- add new PRs
- infer exact causes without support

## 12. Report Tables

### `reports`

Stores generated user-facing reports.

Fields:

```txt
id
organization_id
analysis_report_context_id
report_type
scope_type
scope_id
period_start
period_end
status
title
summary
body_markdown
structured_json
created_by_user_id
created_at
updated_at
```

Report types:

```txt
weekly
monthly
quarterly
custom
```

### `report_inputs`

Tracks what factual data went into the report.

Fields:

```txt
id
report_id
input_type
input_id
metadata_json
created_at
```

Input types:

```txt
analysis_report_context
analysis_metric
analysis_highlight
activity_event
work_item
source_object
previous_report
```

### `report_artifacts`

Stores additional generated outputs.

Fields:

```txt
id
report_id
artifact_type
status
title
body_markdown
structured_json
asset_url
created_at
updated_at
```

Artifact types:

```txt
comic_script
comic_panels
movie_script
storyboard
slack_update
email_update
executive_summary
```

## 13. Stacked Report Generation

Weekly reports should be generated from activity events and analysis contexts.

Monthly reports should be generated from:

```txt
weekly reports
monthly activity metrics
monthly highlights
monthly risks/open threads
```

Quarterly reports should be generated from:

```txt
monthly reports
quarterly activity metrics
strategic highlights
major projects
recurring risks/open threads
```

Add report lineage:

### `report_links`

Fields:

```txt
id
parent_report_id
child_report_id
link_type
created_at
```

Examples:

```txt
weekly -> monthly
monthly -> quarterly
```

This allows tracing a quarterly statement back to monthly reports, weekly reports, and ultimately source activity.

## 14. Comic and Movie Script Generation

Fun artifacts should use the same report context and saved report.

Do not generate comics directly from GitHub/Linear data.

Flow:

```txt
weekly report
analysis_report_context
selected highlights
Comic Writer Agent
Fact Checker Agent
Editor Agent
save report_artifacts row
```

Comic script output:

```json
{
  "title": "...",
  "style": "office cartoon",
  "panels": [
    {
      "panel": 1,
      "description": "...",
      "caption": "...",
      "dialogue": [],
      "sourceRefs": []
    }
  ]
}
```

Movie script output:

```json
{
  "title": "...",
  "runtimeSeconds": 60,
  "scenes": [
    {
      "scene": 1,
      "description": "...",
      "narration": "...",
      "dialogue": [],
      "sourceRefs": []
    }
  ]
}
```

Important rule:

```txt
The team is the hero. The joke is never an individual employee.
```

## 15. Updated End-to-End Flow

The complete TeamTales data flow should be:

```txt
GitHub / Linear
  -> integrations
  -> sync_scopes
  -> sync_runs / sync_cursors
  -> source_objects
  -> work_items
  -> activity_events
  -> analysis_runs
  -> analysis_metrics
  -> analysis_highlights
  -> analysis_report_contexts
  -> ai_runs
  -> reports
  -> report_artifacts
```

This is the core architecture.

## 16. Implementation Order

Build in this order:

1. `integrations`
2. `integration_credentials`
3. `sync_scopes`
4. `sync_cursors`
5. `sync_runs`
6. `source_objects`
7. GitHub source ingestion
8. Linear source ingestion
9. `people`
10. `external_identities`
11. `work_items`
12. `activity_events`
13. `analysis_runs`
14. `analysis_metrics`
15. `analysis_highlights`
16. `analysis_report_contexts`
17. deterministic markdown report generation
18. `ai_runs`
19. AI weekly report generation
20. fact checking
21. monthly/quarterly stacked reports
22. comic script generation
23. movie script generation

## 17. Orchestrator Role

The orchestrator should coordinate these layers but stay lean.

It should not directly implement GitHub sync, Linear sync, metric computation, or report writing.

For example, for a weekly report:

```txt
Orchestrator:
  1. check integration freshness
  2. enqueue sync jobs if needed
  3. run analysis job
  4. request AI report generation
  5. request fact check
  6. save final report
```

Specialized services/subagents:

```txt
GitHub Sync Worker
Linear Sync Worker
Normalization Worker
Metrics Analyzer
Highlight Analyzer
Report Writer Agent
Fact Checker Agent
Editor Agent
Comic Writer Agent
Movie Script Agent
```

The orchestrator should mostly manage state transitions and retries.

It should not become a giant god object.
