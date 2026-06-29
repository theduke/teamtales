# TeamTales MVP Todos

## Committed

- [x] Bootstrap TypeScript project scaffold.
- [x] Add initial local database schema for project-plan tables.
- [x] Add ingestion primitives for canonical JSON hashing and source object upsert planning.
- [x] Add GitHub and Linear connector contracts/stubs.
- [x] Add deterministic analysis/report context contracts.
- [x] Add AI generation/fact-check/editor contracts.

## Next MVP

- [ ] Add local database access and migration execution.
- [ ] Add encrypted integration credential helpers with token hints and redaction.
- [ ] Add normalization from GitHub/Linear source objects into `work_items` and `activity_events`.
- [ ] Add deterministic markdown report generation from `ReportContext`.
- [ ] Add manual CLI commands for organization setup, integration/scopes, sync, analysis, and reports.
- [ ] Add real GitHub repository sync using PAT credentials.
- [ ] Add real Linear workspace/team sync using PAT credentials.
- [ ] Persist analysis runs, metrics, highlights, report contexts, reports, and report inputs.
- [ ] Add end-to-end fixture tests for sync-to-report flow.

## Deferred

- [ ] Webhooks and replay processing.
- [ ] Historic source object versions.
- [ ] GitHub App and Linear OAuth/App auth flows.
- [ ] UI.
- [ ] Monthly and quarterly stacked reports.
- [ ] Comic and movie artifact generation.
