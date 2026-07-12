import type { JsonValue } from "./json.js";
import type { Provider } from "./providers.js";

export type SyncScopeType =
  | "github.repository"
  | "github.organization"
  | "linear.workspace"
  | "linear.team"
  | "linear.project";

export type SyncRunType =
  | "initial_sync"
  | "incremental_sync"
  | "webhook_sync"
  | "manual_resync"
  | "repair_sync"
  | "reconciliation_sync";

export type SyncRunStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";

export type SyncRunItemAction = "inserted" | "updated" | "unchanged" | "deleted" | "inaccessible" | "skipped" | "failed";

export type CursorKind = "updated_at" | "created_at" | "opaque" | "page_token";

export interface SyncScope {
  id: string;
  organizationId: string;
  integrationId: string;
  provider: Provider;
  scopeType: SyncScopeType;
  externalId: string;
  externalName: string;
  parentScopeId?: string;
  selectionMode: "all" | "selected" | "individual";
  configJson: JsonValue;
  enabled: boolean;
  lastSuccessAt?: Date;
  lastAttemptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncCursor {
  id: string;
  organizationId: string;
  integrationId: string;
  syncScopeId: string;
  provider: Provider;
  objectType: string;
  cursorKind: CursorKind;
  cursorValue?: string;
  highWatermark?: Date;
  lastSuccessAt?: Date;
  lastAttemptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncRun {
  id: string;
  organizationId: string;
  integrationId: string;
  syncScopeId: string;
  provider: Provider;
  runType: SyncRunType;
  status: SyncRunStatus;
  startedAt: Date;
  finishedAt?: Date;
  objectsFetched: number;
  objectsInserted: number;
  objectsUpdated: number;
  objectsUnchanged: number;
  objectsFailed: number;
  activityEventsEmitted: number;
  error?: string;
  createdAt: Date;
}

export interface SyncRunItem {
  id: string;
  syncRunId: string;
  objectType: string;
  externalId: string;
  action: SyncRunItemAction;
  status: SyncRunStatus;
  error?: string;
  createdAt: Date;
}

export interface SyncRunCounters {
  objectsFetched: number;
  objectsInserted: number;
  objectsUpdated: number;
  objectsUnchanged: number;
  objectsFailed: number;
  activityEventsEmitted: number;
}

export const zeroSyncRunCounters = (): SyncRunCounters => ({
  objectsFetched: 0,
  objectsInserted: 0,
  objectsUpdated: 0,
  objectsUnchanged: 0,
  objectsFailed: 0,
  activityEventsEmitted: 0,
});
