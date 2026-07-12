# Provider-resource sync state tracking

## Goal

Make synchronization resumable, bounded, and observable independently of a
provider's object model. A GitHub organization with many repositories must not
be one long inline request: its repositories become durable work units whose
state can be retried, resumed, and displayed in the UI. The same mechanism must
work for Linear workspaces, teams, projects, and future providers.

This plan deliberately separates three concerns:

1. **Selection** — what the customer wants synchronized (`sync_scopes`).
2. **Inventory** — provider resources discovered from the provider API
   (`provider_resources`).
3. **Execution** — a parent sync request and its per-resource child runs
   (`sync_runs`).

Raw provider records remain in `source_objects`; normalized work items and
activity remain in `work_items` and `activity_events`.

## Current gap

`sync_scopes` currently represents both selection and the executable unit.
For a `github.organization` scope with `selectionMode = all`, the connector
lists repositories and synchronizes them inline under one `sync_runs` row.
There is no persistent repository inventory, child run, checkpoint, queue
position, attempt count, or UI-visible progress while that happens.

## Data model

### `provider_resources`

Add a provider-independent inventory table. It records a resource the provider
exposes, not an individual GitHub/Linear source object.

```txt
id                         stable internal ID
organization_id            tenant ownership
integration_id             credential/integration that discovered it
provider                   github | linear | ...
resource_type              github.organization | github.repository |
                           linear.workspace | linear.team | ...
external_id                provider's immutable ID
external_parent_id         provider parent ID, when available
parent_resource_id         internal hierarchy link, nullable
display_name               e.g. acme/widgets
external_url               nullable canonical provider URL
metadata_json              small resource metadata; no credential or raw payload
discovery_state            active | inaccessible | deleted
discovered_at
last_seen_at
created_at
updated_at
```

Constraints and indexes:

- Unique `(integration_id, resource_type, external_id)`.
- Index `(integration_id, parent_resource_id, discovery_state)` for hierarchy.
- Index `(organization_id, integration_id, provider, resource_type)` for API
  queries.

The resource inventory is refreshed during provider discovery and whenever an
organization/workspace parent is expanded. Missing resources are marked
`deleted` only after a successful complete discovery; a failed page must never
mark resources absent.

### Scope-to-resource relationship

Keep `sync_scopes` as the customer-facing selection policy. Add nullable
`provider_resource_id` to associate a scope with the inventory row that
represents it. Preserve `external_id` and `external_name` during migration for
backward compatibility and auditability.

For an `all` parent scope, do **not** create configuration scopes for every
child merely to execute them. The scheduler selects active descendant resources
according to the parent scope's policy. For an explicit `selected` policy,
child scopes continue to represent direct inclusion. This avoids confusing a
discovered inventory row with an intentional selection.

The scheduler materializes an effective resource set:

```txt
enabled individual scope          -> its resource
enabled selected parent scope     -> explicitly selected child resources
enabled all parent scope          -> all active discovered descendants of the
                                      executable resource type
```

Initially executable types are `github.repository` and `linear.team`; other
types can opt in through provider metadata without changing the schema.

### Per-resource state and checkpoints

Extend `provider_resources` with a small denormalized status projection:

```txt
sync_status                idle | queued | running | succeeded | failed |
                           blocked | disabled
current_sync_run_id        nullable child run currently owning the resource
last_sync_started_at
last_sync_succeeded_at
last_sync_failed_at
last_sync_error            redacted and bounded
next_attempt_at            nullable retry eligibility
consecutive_failure_count
```

Move checkpoint ownership from scope to resource by adding
`provider_resource_id` to `sync_cursors`, then make it non-null after backfill.
The uniqueness rule becomes
`(provider_resource_id, object_type, cursor_kind)`. Retain `sync_scope_id`
temporarily only for migration/audit compatibility; new code reads and writes
resource-owned cursors. This lets one repository resume without affecting the
cursor of another repository under the same organization selection.

### Parent and child sync runs

Reuse `sync_runs` instead of introducing a second queue table. Add:

```txt
parent_sync_run_id         nullable self-reference
provider_resource_id       nullable for legacy/root runs; required for child runs
run_kind                   orchestration | resource
attempt                    1-based attempt number
queued_at
lease_expires_at           nullable; protects work after worker death
next_attempt_at            nullable
```

Status transitions:

```txt
child:  queued -> running -> succeeded
                         -> failed -> queued       (retryable)
                         -> blocked                (manual intervention)
parent: queued -> running -> completed | failed | completed_with_errors
```

Use a terminal `completed_with_errors` parent status, or represent it as
`completed` plus non-zero failed children if changing the status union is too
disruptive. The API should expose it explicitly either way.

Required indexes:

- `(parent_sync_run_id, status, created_at)` for progress aggregation.
- `(provider_resource_id, status, next_attempt_at)` for worker claims.
- `(status, next_attempt_at, queued_at)` for queue polling.
- Unique active run guard for a resource, implemented with a transactional
  claim/update rather than a MySQL partial unique index.

`sync_run_items` remains the lower-level audit trail for source-object actions;
it is not the unit-of-work queue.

## Execution flow

### Enqueue

`POST /api/sync/:provider` becomes an enqueue operation:

1. Authorize the organization and resolve the requested scope/integration.
2. Create a root `sync_runs` row with `run_kind = orchestration`, `status =
queued`.
3. Refresh the selected parent inventory where required (e.g. list GitHub org
   repositories); persist `provider_resources` transactionally per page.
4. Calculate the effective executable resource set from selection + inventory.
5. Insert one queued child `sync_runs` row per resource. Update each
   `provider_resources.sync_status` to `queued`.
6. Return `202 Accepted` with the root run ID and an initial summary. The HTTP
   request never fetches every pull request itself.

If inventory refresh cannot complete, the root run fails before child creation;
existing active inventory is never silently treated as a complete `all` set.

### Batch worker

Introduce a server/CLI worker entrypoint such as `sync-worker` (and a single
batch mode for local development). It claims at most `SYNC_BATCH_SIZE` child
runs, default `10`, with a transaction:

1. Select eligible `queued` rows (`next_attempt_at <= now`) in stable order.
2. Atomically set each to `running`, set `lease_expires_at`, and set its
   resource state to `running`.
3. Run each resource with bounded concurrency (`SYNC_WORKER_CONCURRENCY`,
   default `3`).
4. Persist source objects, normalized output, cursors, run counters, and
   resource state atomically per resource.
5. Update the root summary after every completed child.

On startup and on each batch, reclaim expired leases. A reclaimed child resumes
from its resource-owned cursor. Retry transient provider failures with capped
exponential backoff; authentication/permission failures become `blocked` and
do not hot-loop. Persist only redacted failure text.

For the initial implementation, an API trigger may run one batch inline after
enqueueing for local feedback, but it must use the exact same claim path and
still return the root run immediately. Production should use the worker.

### Completion and progress

The root run is recomputed from child rows:

```txt
total = all child runs
queued, running, succeeded, failed, blocked = count by child status
processed = succeeded + failed + blocked
progress = processed / total (null when total is zero)
```

Report object counters as sums of completed/running children. A successful
child updates the resource's last-success state and its cursors. A failed child
does not advance its successful cursor.

## API contract

Add typed DTOs in `@teamtales/common/api`; do not expose database rows or raw
provider payloads.

### Trigger / enqueue

`POST /api/sync/:provider`

- Keep the existing request filters (`organizationId`, `integrationId`,
  `syncScopeId`).
- Return `202` and `SyncRunSummaryDto`, with `status: "queued"` or
  `"running"`, instead of waiting for completion.

### Run summary

`GET /api/sync-runs/:syncRunId?organizationId=...`

Returns a root or child `SyncRunSummaryDto`:

```ts
type SyncRunSummaryDto = {
  id: string;
  parentSyncRunId?: string;
  provider: Provider;
  integrationId: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "blocked"
    | "completed"
    | "completed_with_errors";
  runKind: "orchestration" | "resource";
  resource?: ProviderResourceSummaryDto;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    blocked: number;
    processed: number;
  };
  counters: SyncCountersDto;
  error?: string;
  updatedAt: string;
};
```

### Child-resource progress

`GET /api/sync-runs/:syncRunId/resources?organizationId=...&status=...&cursor=...&limit=...`

Returns cursor-paginated `SyncResourceProgressDto` children. Include resource
display name/type, current status, attempt, timestamps, next retry time,
counters, and redacted error. Default ordering: running, failed/blocked,
queued, then succeeded. This endpoint powers an expandable run detail without
loading thousands of resources at once.

### Current organization status

`GET /api/organizations/:organizationId/sync-status?integrationId=...&provider=...&resourceType=...&status=...&cursor=...&limit=...`

Returns the latest sync status for provider resources, regardless of which run
created it. This powers a future Sync page and integration detail badge. Include
an `activeRun` summary when one exists and aggregate counts grouped by state.

Authorization for all three endpoints requires membership in the organization.
`organizationId` remains explicit until the API's resource-scoping convention
is unified. Do not return credentials, raw source JSON, or unredacted errors.

Future write endpoints, deliberately out of the first slice:

- `POST /api/sync-runs/:id/cancel`
- `POST /api/sync-runs/:id/retry-failed`
- `POST /api/provider-resources/:id/resync`

## UI integration contract

No UI change is required in the first migration, but build the APIs so the UI
can poll every 2–5 seconds while a root run is non-terminal:

1. Trigger sync and retain the returned root run ID.
2. Poll run summary for aggregate progress and counters.
3. Fetch the paginated resource list for live rows and errors.
4. Stop polling on terminal status; refresh dashboard scope timestamps.

The Sync page should show an aggregate progress bar, status counts, current
resources, failed resources/retry times, and a link to the latest completed
run. It must treat `queued` as normal, never infer completion from an empty
HTTP response, and preserve progress across page reload by reading the active
run from organization sync status.

## Migration and rollout

1. Add the new tables/columns and DTOs behind read-compatible code.
2. Backfill `provider_resources` from existing `sync_scopes`; create hierarchy
   links when parent scopes can be resolved. Backfill cursors to the matching
   resource. Flag ambiguous rows for a safe full re-sync rather than guessing.
3. Change provider discovery to upsert resource inventory and link scopes.
4. Implement enqueue, child-run creation, and a worker with GitHub repository
   children first. Keep the current inline organization path only behind a
   temporary compatibility flag.
5. Switch GitHub `all` organization scopes to the queue. Verify retry and
   lease recovery with forced worker interruption.
6. Move Linear team execution onto the same path.
7. Add read endpoints and then the Sync UI polling/progress view.
8. Remove inline organization expansion and legacy cursor ownership after all
   integrations have migrated.

## Tests and acceptance criteria

- A 250-repository organization creates 250 child runs but processes only the
  configured batch/concurrency at once.
- Interrupting a worker after 40 completed repositories reclaims only its
  leased children; completed resources are not fetched again, and unfinished
  resources resume from their own cursors.
- A failed repository does not block unrelated repositories; retry backoff and
  blocked-auth state are persisted and visible through the APIs.
- An `all` scope adds newly discovered repositories on the next enqueue and
  marks genuinely removed repositories inaccessible/deleted only after a
  complete discovery.
- API authorization prevents cross-organization run/resource reads.
- Cursor pagination is stable while child run statuses change.
- Error and log payloads contain no credential material.
- Existing individual repository and Linear scope syncs retain their behavior
  during migration.
