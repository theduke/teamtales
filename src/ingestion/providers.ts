import type { JsonValue } from "./json.js";
import type { IncomingSourceObject, SourceObjectUpsertPlan } from "./source-object.js";
import type { SyncCursor, SyncRun, SyncScope } from "./sync.js";

export type Provider = "github" | "linear";

export interface IntegrationCredential {
  integrationId: string;
  encryptedSecret: string;
  secretHint?: string;
  expiresAt?: Date;
}

export interface ConnectorExecutionContext {
  organizationId: string;
  integrationId: string;
  scope: SyncScope;
  run: SyncRun;
  cursors: SyncCursor[];
  credential: IntegrationCredential;
}

export interface ConnectorFetchResult {
  objects: IncomingSourceObject[];
  cursorUpdates: ConnectorCursorUpdate[];
  metadata?: JsonValue;
}

export interface ConnectorCursorUpdate {
  objectType: string;
  cursorValue?: string;
  highWatermark?: Date;
}

export interface SourceConnector {
  readonly provider: Provider;
  readonly supportedObjectTypes: readonly string[];
  readonly supportedScopeTypes: readonly string[];
  fetchSourceObjects(context: ConnectorExecutionContext): Promise<ConnectorFetchResult>;
  planUpserts?(objects: IncomingSourceObject[]): Promise<SourceObjectUpsertPlan[]>;
}

export class ConnectorNotImplementedError extends Error {
  constructor(provider: Provider, operation: string) {
    super(`${provider} connector does not implement ${operation} yet`);
    this.name = "ConnectorNotImplementedError";
  }
}
