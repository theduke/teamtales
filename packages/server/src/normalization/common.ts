import type { ActivityEvent, Provider, WorkItem, WorkItemStatus, WorkType } from "../analysis/types.js";

export type SourceRecord = Record<string, unknown>;

export interface NormalizationContext {
  sourceObjectId?: string;
  workItemId?: string;
  repositoryId?: string;
  linearTeamId?: string;
  linearProjectId?: string;
}

export interface WorkItemNormalizationResult {
  workItem: WorkItem;
  events: ActivityEvent[];
}

export function workItemId(provider: Provider, sourceType: WorkType, externalId: string): string {
  return `${provider}:${sourceType}:${externalId}`;
}

export function eventId(provider: Provider, eventType: string, externalId: string, occurredAt: string): string {
  return `${provider}:${eventType}:${externalId}:${occurredAt}`;
}

export function sourceRef(providerObjectType: string, externalId: string, sourceObjectId?: string): string {
  return sourceObjectId ?? `${providerObjectType}:${externalId}`;
}

export function stringField(record: SourceRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberField(record: SourceRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanField(record: SourceRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function objectField(record: SourceRecord, key: string): SourceRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function arrayField(record: SourceRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function nestedString(record: SourceRecord, path: readonly string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

export function firstString(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined);
}

export function actorId(provider: Provider, user: SourceRecord | undefined): string | undefined {
  if (!user) {
    return undefined;
  }

  if (provider === "github") {
    const login = stringField(user, "login");
    return login ? `github:user:${login}` : undefined;
  }

  const id = stringField(user, "id");
  return id ? `linear:user:${id}` : undefined;
}

export function labelsFromUnknown(values: unknown[]): string[] | undefined {
  const labels = values
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      if (isRecord(value)) {
        return firstString(stringField(value, "name"), stringField(value, "title"));
      }
      return undefined;
    })
    .filter((value): value is string => value !== undefined);

  return labels.length > 0 ? labels : undefined;
}

export function requiredString(record: SourceRecord, keys: readonly string[], description: string): string {
  for (const key of keys) {
    const value = stringField(record, key);
    if (value) {
      return value;
    }
  }

  const numberValue = keys.map((key) => numberField(record, key)).find((value) => value !== undefined);
  if (numberValue !== undefined) {
    return String(numberValue);
  }

  throw new TypeError(`Cannot normalize ${description}: missing ${keys.join(" or ")}`);
}

export function requiredTitle(record: SourceRecord, description: string): string {
  const title = firstString(stringField(record, "title"), stringField(record, "name"));
  if (!title) {
    throw new TypeError(`Cannot normalize ${description}: missing title`);
  }
  return title;
}

export function githubStatus(record: SourceRecord): WorkItemStatus {
  if (booleanField(record, "merged") === true || stringField(record, "merged_at")) {
    return "merged";
  }

  const state = stringField(record, "state");
  if (state === "open") {
    return "open";
  }
  if (state === "closed") {
    return "closed";
  }
  return "unknown";
}

export function linearStatus(record: SourceRecord): WorkItemStatus {
  const completedAt = firstString(stringField(record, "completedAt"), stringField(record, "completed_at"));
  if (completedAt) {
    return "completed";
  }

  const stateType = firstString(nestedString(record, ["state", "type"]), nestedString(record, ["workflowState", "type"]));
  if (stateType === "completed") {
    return "completed";
  }
  if (stateType === "started") {
    return "in_progress";
  }
  if (stateType === "canceled") {
    return "closed";
  }

  return "open";
}

export function isRecord(value: unknown): value is SourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
