import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeGitHubPullRequest,
  normalizeGitHubPullRequestReview,
} from "../../src/normalization/index.js";

describe("GitHub normalization", () => {
  it("normalizes a merged pull request into a work item and exact lifecycle events", () => {
    const result = normalizeGitHubPullRequest(
      {
        id: 42,
        number: 7,
        title: "Ship widget rendering",
        html_url: "https://github.com/acme/widgets/pull/7",
        state: "closed",
        merged: true,
        created_at: "2026-06-27T10:00:00.000Z",
        updated_at: "2026-06-28T12:00:00.000Z",
        merged_at: "2026-06-28T11:30:00.000Z",
        user: { login: "alice" },
        merged_by: { login: "bob" },
        labels: [{ name: "frontend" }],
      },
      { repositoryId: "github:repo:acme/widgets", sourceObjectId: "source_pr_42" },
    );

    assert.deepEqual(result.workItem, {
      id: "github:github_pull_request:42",
      provider: "github",
      sourceType: "github_pull_request",
      externalId: "42",
      title: "Ship widget rendering",
      url: "https://github.com/acme/widgets/pull/7",
      status: "merged",
      createdAtSource: "2026-06-27T10:00:00.000Z",
      updatedAtSource: "2026-06-28T12:00:00.000Z",
      startedAt: "2026-06-27T10:00:00.000Z",
      completedAt: "2026-06-28T11:30:00.000Z",
      repositoryId: "github:repo:acme/widgets",
      labels: ["frontend"],
    });

    assert.deepEqual(
      result.events.map((event) => ({
        eventType: event.eventType,
        actorPersonId: event.actorPersonId,
        occurredAt: event.occurredAt,
        sourceRef: event.sourceRef,
      })),
      [
        {
          eventType: "github.pr_opened",
          actorPersonId: "github:user:alice",
          occurredAt: "2026-06-27T10:00:00.000Z",
          sourceRef: "source_pr_42",
        },
        {
          eventType: "github.pr_merged",
          actorPersonId: "github:user:bob",
          occurredAt: "2026-06-28T11:30:00.000Z",
          sourceRef: "source_pr_42",
        },
      ],
    );
  });

  it("attaches review events to the provided normalized work item", () => {
    const event = normalizeGitHubPullRequestReview(
      {
        id: 99,
        state: "approved",
        submitted_at: "2026-06-28T10:00:00.000Z",
        html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-99",
        user: { login: "carol" },
      },
      { workItemId: "github:github_pull_request:42", repositoryId: "github:repo:acme/widgets" },
    );

    assert.equal(event.eventType, "github.pr_reviewed");
    assert.equal(event.workItemId, "github:github_pull_request:42");
    assert.equal(event.actorPersonId, "github:user:carol");
    assert.equal(event.title, "Approved pull request");
  });
});
