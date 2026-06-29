import type { ActivityEvent, WorkItem } from "../analysis/types.js";
import {
  actorId,
  arrayField,
  eventId,
  firstString,
  isRecord,
  labelsFromUnknown,
  linearStatus,
  nestedString,
  objectField,
  requiredString,
  requiredTitle,
  sourceRef,
  stringField,
  type NormalizationContext,
  type SourceRecord,
  type WorkItemNormalizationResult,
  workItemId,
} from "./common.js";

export function normalizeLinearIssue(raw: SourceRecord, context: NormalizationContext = {}): WorkItemNormalizationResult {
  const externalId = requiredString(raw, ["id", "identifier", "number"], "Linear issue");
  const title = requiredTitle(raw, "Linear issue");
  const url = stringField(raw, "url");
  const createdAt = firstString(stringField(raw, "createdAt"), stringField(raw, "created_at"));
  const updatedAt = firstString(stringField(raw, "updatedAt"), stringField(raw, "updated_at"));
  const completedAt = firstString(stringField(raw, "completedAt"), stringField(raw, "completed_at"));
  const startedAt = firstString(stringField(raw, "startedAt"), stringField(raw, "started_at"));
  const teamId = context.linearTeamId ?? nestedString(raw, ["team", "id"]);
  const projectId = context.linearProjectId ?? nestedString(raw, ["project", "id"]);
  const source = sourceRef("linear.issue", externalId, context.sourceObjectId);
  const id = workItemId("linear", "linear_issue", externalId);
  const labels = labelsFromUnknown(arrayField(raw, "labels"));

  const workItem: WorkItem = {
    id,
    provider: "linear",
    sourceType: "linear_issue",
    externalId,
    title,
    ...(url ? { url } : {}),
    status: linearStatus(raw),
    ...(createdAt ? { createdAtSource: createdAt } : {}),
    ...(updatedAt ? { updatedAtSource: updatedAt } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(teamId ? { linearTeamId: teamId } : {}),
    ...(projectId ? { linearProjectId: projectId } : {}),
    ...(labels ? { labels } : {}),
  };

  const events: ActivityEvent[] = [];
  const actor = actorId("linear", objectField(raw, "creator"));
  if (createdAt) {
    events.push(linearEvent("linear.issue_created", externalId, createdAt, title, {
      actorPersonId: actor,
      workItemId: id,
      linearTeamId: teamId,
      linearProjectId: projectId,
      url,
      sourceRef: source,
      metadata: issueMetadata(raw),
    }));
  }

  events.push(...linearIssueHistoryEvents(raw, id, teamId, projectId, source));

  if (completedAt && !hasExactCompletedHistory(raw)) {
    events.push(linearEvent("linear.issue_completed", externalId, completedAt, `Observed as completed: ${title}`, {
      workItemId: id,
      linearTeamId: teamId,
      linearProjectId: projectId,
      url,
      sourceRef: source,
      metadata: {
        ...issueMetadata(raw),
        conservative: true,
        reason: "Linear current state includes completion, but no exact transition history was provided.",
      },
    }));
  }

  if (updatedAt && updatedAt !== createdAt && updatedAt !== completedAt) {
    events.push(linearEvent("linear.issue_updated", externalId, updatedAt, title, {
      workItemId: id,
      linearTeamId: teamId,
      linearProjectId: projectId,
      url,
      sourceRef: source,
      metadata: issueMetadata(raw),
    }));
  }

  return { workItem, events: dedupeEvents(events) };
}

export function normalizeLinearComment(raw: SourceRecord, context: NormalizationContext = {}): ActivityEvent {
  const externalId = requiredString(raw, ["id"], "Linear comment");
  const occurredAt = requiredString(raw, ["createdAt", "created_at", "updatedAt", "updated_at"], "Linear comment");

  return linearEvent("linear.issue_commented", externalId, occurredAt, "Commented on Linear issue", {
    actorPersonId: actorId("linear", objectField(raw, "user")),
    workItemId: context.workItemId,
    linearTeamId: context.linearTeamId,
    linearProjectId: context.linearProjectId,
    body: stringField(raw, "body"),
    url: stringField(raw, "url"),
    sourceRef: sourceRef("linear.comment", externalId, context.sourceObjectId),
    metadata: {
      issueId: nestedString(raw, ["issue", "id"]),
    },
  });
}

export function normalizeLinearProject(raw: SourceRecord, context: NormalizationContext = {}): WorkItemNormalizationResult {
  const externalId = requiredString(raw, ["id"], "Linear project");
  const title = requiredTitle(raw, "Linear project");
  const url = stringField(raw, "url");
  const createdAt = firstString(stringField(raw, "createdAt"), stringField(raw, "created_at"));
  const updatedAt = firstString(stringField(raw, "updatedAt"), stringField(raw, "updated_at"));
  const completedAt = firstString(stringField(raw, "completedAt"), stringField(raw, "completed_at"));
  const teamId = context.linearTeamId ?? nestedString(raw, ["team", "id"]);
  const source = sourceRef("linear.project", externalId, context.sourceObjectId);
  const id = workItemId("linear", "linear_project", externalId);

  const workItem: WorkItem = {
    id,
    provider: "linear",
    sourceType: "linear_project",
    externalId,
    title,
    ...(url ? { url } : {}),
    status: completedAt ? "completed" : "open",
    ...(createdAt ? { createdAtSource: createdAt } : {}),
    ...(updatedAt ? { updatedAtSource: updatedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(teamId ? { linearTeamId: teamId } : {}),
    linearProjectId: externalId,
  };

  const events: ActivityEvent[] = [];
  if (createdAt) {
    events.push(linearEvent("linear.project_created", externalId, createdAt, title, {
      workItemId: id,
      linearTeamId: teamId,
      linearProjectId: externalId,
      url,
      sourceRef: source,
    }));
  }
  if (completedAt) {
    events.push(linearEvent("linear.project_completed", externalId, completedAt, `Observed as completed: ${title}`, {
      workItemId: id,
      linearTeamId: teamId,
      linearProjectId: externalId,
      url,
      sourceRef: source,
      metadata: {
        conservative: true,
        reason: "Linear current project state includes completion, but no exact transition history was provided.",
      },
    }));
  } else if (updatedAt && updatedAt !== createdAt) {
    events.push(linearEvent("linear.project_updated", externalId, updatedAt, title, {
      workItemId: id,
      linearTeamId: teamId,
      linearProjectId: externalId,
      url,
      sourceRef: source,
    }));
  }

  return { workItem, events };
}

function linearIssueHistoryEvents(
  raw: SourceRecord,
  workId: string,
  teamId: string | undefined,
  projectId: string | undefined,
  source: string,
): ActivityEvent[] {
  return historyRecords(raw)
    .filter((history) => isStatusHistory(history))
    .map((history) => {
      const externalId = requiredString(history, ["id"], "Linear issue history");
      const occurredAt = requiredString(history, ["createdAt", "created_at"], "Linear issue history");
      const toState = firstString(stringField(history, "toState"), stringField(history, "to"), nestedString(history, ["to", "name"]));
      const title = toState ? `Status changed to ${toState}` : "Status changed";
      const issueId = requiredString(raw, ["id", "identifier", "number"], "Linear issue");
      const eventType = isCompletedState(history) ? "linear.issue_completed" : "linear.issue_status_changed";

      return linearEvent(eventType, externalId, occurredAt, title, {
        actorPersonId: actorId("linear", objectField(history, "actor") ?? objectField(history, "user")),
        workItemId: workId,
        linearTeamId: teamId,
        linearProjectId: projectId,
        url: stringField(raw, "url"),
        sourceRef: source,
        metadata: {
          issueId,
          fromState: firstString(stringField(history, "fromState"), stringField(history, "from"), nestedString(history, ["from", "name"])),
          toState,
          exactHistory: true,
        },
      });
    });
}

function historyRecords(raw: SourceRecord): SourceRecord[] {
  const direct = arrayField(raw, "history");
  const history = objectField(raw, "history");
  const nodes = history ? arrayField(history, "nodes") : [];
  const entries = direct.length > 0 ? direct : nodes;
  return entries.filter(isRecord);
}

function isStatusHistory(history: SourceRecord): boolean {
  const field = firstString(stringField(history, "field"), stringField(history, "type"));
  return field === "state" || field === "status" || field === "workflowState";
}

function isCompletedState(history: SourceRecord): boolean {
  const toState = firstString(stringField(history, "toState"), stringField(history, "to"), nestedString(history, ["to", "type"]));
  return toState === "completed" || toState === "Done" || toState === "done";
}

function hasExactCompletedHistory(raw: SourceRecord): boolean {
  return historyRecords(raw).some((history) => isStatusHistory(history) && isCompletedState(history));
}

function issueMetadata(raw: SourceRecord): Record<string, unknown> {
  return {
    identifier: stringField(raw, "identifier"),
    stateName: firstString(nestedString(raw, ["state", "name"]), nestedString(raw, ["workflowState", "name"])),
    assigneeId: nestedString(raw, ["assignee", "id"]),
  };
}

function linearEvent(
  eventType: string,
  externalId: string,
  occurredAt: string,
  title: string,
  values: Omit<ActivityEvent, "id" | "provider" | "eventType" | "occurredAt" | "title">,
): ActivityEvent {
  return {
    id: eventId("linear", eventType, externalId, occurredAt),
    provider: "linear",
    eventType,
    occurredAt,
    title,
    ...stripUndefined(values),
  };
}

function dedupeEvents(events: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) {
      return false;
    }
    seen.add(event.id);
    return true;
  });
}

function stripUndefined<T extends SourceRecord>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
