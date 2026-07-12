import type { ActivityEvent, WorkItem } from "../analysis/types.js";
import {
  actorId,
  arrayField,
  eventId,
  githubStatus,
  labelsFromUnknown,
  numberField,
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

export function normalizeGitHubPullRequest(
  raw: SourceRecord,
  context: NormalizationContext = {},
): WorkItemNormalizationResult {
  const externalId = requiredString(raw, ["id", "node_id", "number"], "GitHub pull request");
  const number = numberField(raw, "number");
  const title = requiredTitle(raw, "GitHub pull request");
  const url = stringField(raw, "html_url");
  const createdAt = stringField(raw, "created_at");
  const updatedAt = stringField(raw, "updated_at");
  const closedAt = stringField(raw, "closed_at");
  const mergedAt = stringField(raw, "merged_at");
  const source = sourceRef("github.pull_request", externalId, context.sourceObjectId);
  const id = workItemId("github", "github_pull_request", externalId);
  const labels = labelsFromUnknown(arrayField(raw, "labels"));

  const workItem: WorkItem = {
    id,
    provider: "github",
    sourceType: "github_pull_request",
    externalId,
    title,
    ...(url ? { url } : {}),
    status: githubStatus(raw),
    ...(createdAt ? { createdAtSource: createdAt } : {}),
    ...(updatedAt ? { updatedAtSource: updatedAt } : {}),
    ...(createdAt ? { startedAt: createdAt } : {}),
    ...(mergedAt ? { completedAt: mergedAt } : closedAt ? { completedAt: closedAt } : {}),
    ...(context.repositoryId ? { repositoryId: context.repositoryId } : {}),
    ...(labels ? { labels } : {}),
  };

  const actor = actorId("github", objectField(raw, "user"));
  const events: ActivityEvent[] = [];

  if (createdAt) {
    events.push(
      githubEvent("github.pr_opened", externalId, createdAt, title, {
        actorPersonId: actor,
        workItemId: id,
        repositoryId: context.repositoryId,
        url,
        sourceRef: source,
        metadata: number === undefined ? undefined : { number },
      }),
    );
  }

  if (mergedAt) {
    events.push(
      githubEvent("github.pr_merged", externalId, mergedAt, title, {
        actorPersonId: actorId("github", objectField(raw, "merged_by")) ?? actor,
        workItemId: id,
        repositoryId: context.repositoryId,
        url,
        sourceRef: source,
        metadata: number === undefined ? undefined : { number },
      }),
    );
  } else if (closedAt && stringField(raw, "state") === "closed") {
    events.push(
      githubEvent("github.pr_closed", externalId, closedAt, title, {
        actorPersonId: actor,
        workItemId: id,
        repositoryId: context.repositoryId,
        url,
        sourceRef: source,
        metadata: number === undefined ? undefined : { number },
      }),
    );
  }

  return { workItem, events };
}

export function normalizeGitHubIssue(
  raw: SourceRecord,
  context: NormalizationContext = {},
): WorkItemNormalizationResult {
  const externalId = requiredString(raw, ["id", "node_id", "number"], "GitHub issue");
  const number = numberField(raw, "number");
  const title = requiredTitle(raw, "GitHub issue");
  const url = stringField(raw, "html_url");
  const createdAt = stringField(raw, "created_at");
  const updatedAt = stringField(raw, "updated_at");
  const closedAt = stringField(raw, "closed_at");
  const source = sourceRef("github.issue", externalId, context.sourceObjectId);
  const id = workItemId("github", "github_issue", externalId);
  const labels = labelsFromUnknown(arrayField(raw, "labels"));

  const workItem: WorkItem = {
    id,
    provider: "github",
    sourceType: "github_issue",
    externalId,
    title,
    ...(url ? { url } : {}),
    status: githubStatus(raw),
    ...(createdAt ? { createdAtSource: createdAt } : {}),
    ...(updatedAt ? { updatedAtSource: updatedAt } : {}),
    ...(createdAt ? { startedAt: createdAt } : {}),
    ...(closedAt ? { completedAt: closedAt } : {}),
    ...(context.repositoryId ? { repositoryId: context.repositoryId } : {}),
    ...(labels ? { labels } : {}),
  };

  const actor = actorId("github", objectField(raw, "user"));
  const events: ActivityEvent[] = [];
  if (createdAt) {
    events.push(
      githubEvent("github.issue_opened", externalId, createdAt, title, {
        actorPersonId: actor,
        workItemId: id,
        repositoryId: context.repositoryId,
        url,
        sourceRef: source,
        metadata: number === undefined ? undefined : { number },
      }),
    );
  }
  if (closedAt && stringField(raw, "state") === "closed") {
    events.push(
      githubEvent("github.issue_closed", externalId, closedAt, title, {
        actorPersonId: actor,
        workItemId: id,
        repositoryId: context.repositoryId,
        url,
        sourceRef: source,
        metadata: number === undefined ? undefined : { number },
      }),
    );
  }

  return { workItem, events };
}

export function normalizeGitHubPullRequestReview(
  raw: SourceRecord,
  context: NormalizationContext = {},
): ActivityEvent {
  const externalId = requiredString(raw, ["id", "node_id"], "GitHub pull request review");
  const pullRequestUrl = stringField(raw, "pull_request_url");
  const occurredAt = requiredString(
    raw,
    ["submitted_at", "created_at", "updated_at"],
    `GitHub pull request review ${externalId}${pullRequestUrl ? ` for ${pullRequestUrl}` : ""}`,
  );
  const title = reviewTitle(raw);

  return githubEvent("github.pr_reviewed", externalId, occurredAt, title, {
    actorPersonId: actorId("github", objectField(raw, "user")),
    workItemId: context.workItemId,
    repositoryId: context.repositoryId,
    url: stringField(raw, "html_url"),
    sourceRef: sourceRef("github.pull_request_review", externalId, context.sourceObjectId),
    metadata: {
      state: stringField(raw, "state") ?? "unknown",
      pullRequestUrl,
    },
  });
}

export function normalizeGitHubPullRequestComment(
  raw: SourceRecord,
  context: NormalizationContext = {},
): ActivityEvent {
  const externalId = requiredString(raw, ["id", "node_id"], "GitHub pull request comment");
  const occurredAt = requiredString(
    raw,
    ["created_at", "updated_at"],
    "GitHub pull request comment",
  );
  const body = stringField(raw, "body");

  return githubEvent(
    "github.pr_review_commented",
    externalId,
    occurredAt,
    "Reviewed pull request code",
    {
      actorPersonId: actorId("github", objectField(raw, "user")),
      workItemId: context.workItemId,
      repositoryId: context.repositoryId,
      body,
      url: stringField(raw, "html_url"),
      sourceRef: sourceRef("github.pull_request_comment", externalId, context.sourceObjectId),
      metadata: {
        path: stringField(raw, "path"),
        pullRequestUrl: stringField(raw, "pull_request_url"),
      },
    },
  );
}

export function normalizeGitHubIssueComment(
  raw: SourceRecord,
  context: NormalizationContext = {},
): ActivityEvent {
  const externalId = requiredString(raw, ["id", "node_id"], "GitHub issue comment");
  const occurredAt = requiredString(raw, ["created_at", "updated_at"], "GitHub issue comment");
  const body = stringField(raw, "body");

  return githubEvent("github.pr_commented", externalId, occurredAt, "Commented on pull request", {
    actorPersonId: actorId("github", objectField(raw, "user")),
    workItemId: context.workItemId,
    repositoryId: context.repositoryId,
    body,
    url: stringField(raw, "html_url"),
    sourceRef: sourceRef("github.issue_comment", externalId, context.sourceObjectId),
    metadata: {
      issueUrl: stringField(raw, "issue_url"),
    },
  });
}

export function normalizeGitHubCommit(
  raw: SourceRecord,
  context: NormalizationContext = {},
): ActivityEvent {
  const externalId = requiredString(raw, ["sha", "node_id"], "GitHub commit");
  const commit = objectField(raw, "commit");
  const author = commit ? objectField(commit, "author") : undefined;
  const occurredAt =
    stringField(author ?? {}, "date") ?? requiredString(raw, ["created_at"], "GitHub commit");
  const message = commit ? stringField(commit, "message") : undefined;

  return githubEvent(
    "github.commit_authored",
    externalId,
    occurredAt,
    firstLine(message) ?? "Authored commit",
    {
      actorPersonId: actorId("github", objectField(raw, "author")),
      repositoryId: context.repositoryId,
      body: message,
      url: stringField(raw, "html_url"),
      sourceRef: sourceRef("github.commit", externalId, context.sourceObjectId),
    },
  );
}

function githubEvent(
  eventType: string,
  externalId: string,
  occurredAt: string,
  title: string,
  values: Omit<ActivityEvent, "id" | "provider" | "eventType" | "occurredAt" | "title">,
): ActivityEvent {
  return {
    id: eventId("github", eventType, externalId, occurredAt),
    provider: "github",
    eventType,
    occurredAt,
    title,
    ...stripUndefined(values),
  };
}

function reviewTitle(raw: SourceRecord): string {
  const state = stringField(raw, "state");
  if (state === "approved") {
    return "Approved pull request";
  }
  if (state === "changes_requested") {
    return "Requested pull request changes";
  }
  return "Reviewed pull request";
}

function firstLine(value: string | undefined): string | undefined {
  return value?.split("\n")[0];
}

function stripUndefined<T extends SourceRecord>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
