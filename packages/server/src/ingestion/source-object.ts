import { hashCanonicalJson, type ContentHash, type JsonValue } from "./json.js";
import type { Provider } from "./providers.js";

export type GitHubSourceObjectType =
  | "github.repository"
  | "github.pull_request"
  | "github.pull_request_review"
  | "github.pull_request_comment"
  | "github.issue"
  | "github.issue_comment"
  | "github.commit"
  | "github.user";

export type LinearSourceObjectType =
  | "linear.workspace"
  | "linear.team"
  | "linear.project"
  | "linear.issue"
  | "linear.comment"
  | "linear.user"
  | "linear.label"
  | "linear.workflow_state";

export type SourceObjectType = GitHubSourceObjectType | LinearSourceObjectType;
export type SourceState = "active" | "deleted" | "inaccessible" | "error";
export type SourceObjectUpsertAction = "insert" | "update" | "unchanged";

export interface SourceObjectIdentity {
  organizationId: string;
  integrationId: string;
  syncScopeId: string;
  provider: Provider;
  objectType: SourceObjectType;
  externalId: string;
}

export interface IncomingSourceObject extends SourceObjectIdentity {
  rawJson: JsonValue;
  externalUrl?: string;
  externalCreatedAt?: Date;
  externalUpdatedAt?: Date;
  externalDeletedAt?: Date;
  sourceState?: SourceState;
}

export interface PersistedSourceObject extends IncomingSourceObject {
  id: string;
  contentHash: ContentHash;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastChangedAt: Date;
  sourceState: SourceState;
  createdAt: Date;
  updatedAt: Date;
}

export interface SourceObjectInsertPlan {
  action: "insert";
  contentHash: ContentHash;
  values: Omit<PersistedSourceObject, "id" | "createdAt" | "updatedAt">;
}

export interface SourceObjectUpdatePlan {
  action: "update";
  contentHash: ContentHash;
  existingId: string;
  values: {
    externalUrl: string | undefined;
    externalCreatedAt: Date | undefined;
    externalUpdatedAt: Date | undefined;
    externalDeletedAt: Date | undefined;
    rawJson: JsonValue;
    contentHash: ContentHash;
    lastSeenAt: Date;
    lastChangedAt: Date;
    sourceState: SourceState;
  };
}

export interface SourceObjectUnchangedPlan {
  action: "unchanged";
  contentHash: ContentHash;
  existingId: string;
  values: Pick<PersistedSourceObject, "lastSeenAt" | "sourceState">;
}

export type SourceObjectUpsertPlan =
  | SourceObjectInsertPlan
  | SourceObjectUpdatePlan
  | SourceObjectUnchangedPlan;

export function sourceObjectConflictKey(identity: SourceObjectIdentity): string {
  return [
    identity.organizationId,
    identity.integrationId,
    identity.syncScopeId,
    identity.provider,
    identity.objectType,
    identity.externalId,
  ].join(":");
}

export function planSourceObjectUpsert(
  incoming: IncomingSourceObject,
  existing: PersistedSourceObject | undefined,
  now: Date = new Date(),
): SourceObjectUpsertPlan {
  const contentHash = hashCanonicalJson(incoming.rawJson);
  const sourceState = incoming.sourceState ?? "active";

  if (!existing) {
    return {
      action: "insert",
      contentHash,
      values: {
        ...incoming,
        contentHash,
        sourceState,
        firstSeenAt: now,
        lastSeenAt: now,
        lastChangedAt: now,
      },
    };
  }

  if (existing.contentHash === contentHash && existing.sourceState === sourceState) {
    return {
      action: "unchanged",
      contentHash,
      existingId: existing.id,
      values: {
        lastSeenAt: now,
        sourceState,
      },
    };
  }

  return {
    action: "update",
    contentHash,
    existingId: existing.id,
    values: {
      externalUrl: incoming.externalUrl,
      externalCreatedAt: incoming.externalCreatedAt,
      externalUpdatedAt: incoming.externalUpdatedAt,
      externalDeletedAt: incoming.externalDeletedAt,
      rawJson: incoming.rawJson,
      contentHash,
      lastSeenAt: now,
      lastChangedAt: now,
      sourceState,
    },
  };
}
