import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeLinearComment, normalizeLinearIssue, normalizeLinearProject } from "../../src/normalization/index.js";

describe("Linear normalization", () => {
  it("uses conservative completion wording for current-only issue state", () => {
    const result = normalizeLinearIssue(
      {
        id: "lin_1",
        identifier: "ENG-123",
        title: "Finish onboarding checklist",
        url: "https://linear.app/acme/issue/ENG-123",
        createdAt: "2026-06-20T09:00:00.000Z",
        updatedAt: "2026-06-28T09:00:00.000Z",
        completedAt: "2026-06-27T17:00:00.000Z",
        state: { id: "state_done", name: "Done", type: "completed" },
        team: { id: "team_eng" },
        project: { id: "project_onboarding" },
        creator: { id: "user_alice" },
        assignee: { id: "user_bob" },
        labels: ["customer-impact"],
      },
      { sourceObjectId: "source_linear_issue_1" },
    );

    assert.deepEqual(result.workItem, {
      id: "linear:linear_issue:lin_1",
      provider: "linear",
      sourceType: "linear_issue",
      externalId: "lin_1",
      title: "Finish onboarding checklist",
      url: "https://linear.app/acme/issue/ENG-123",
      status: "completed",
      createdAtSource: "2026-06-20T09:00:00.000Z",
      updatedAtSource: "2026-06-28T09:00:00.000Z",
      completedAt: "2026-06-27T17:00:00.000Z",
      linearTeamId: "team_eng",
      linearProjectId: "project_onboarding",
      labels: ["customer-impact"],
    });

    const eventTypes = result.events.map((event) => event.eventType);
    assert.deepEqual(eventTypes, ["linear.issue_created", "linear.issue_completed", "linear.issue_updated"]);
    assert.equal(result.events[1]?.title, "Observed as completed: Finish onboarding checklist");
    assert.equal(result.events[1]?.metadata?.["conservative"], true);
    assert.equal(result.events.some((event) => event.eventType === "linear.issue_status_changed"), false);
  });

  it("emits exact status changes only when Linear history is provided", () => {
    const result = normalizeLinearIssue({
      id: "lin_2",
      identifier: "ENG-124",
      title: "Release audit log",
      createdAt: "2026-06-21T09:00:00.000Z",
      completedAt: "2026-06-28T13:00:00.000Z",
      state: { name: "Done", type: "completed" },
      history: [
        {
          id: "hist_1",
          field: "state",
          fromState: "In Progress",
          toState: "Done",
          createdAt: "2026-06-28T13:00:00.000Z",
          actor: { id: "user_carol" },
        },
      ],
    });

    const completedEvents = result.events.filter((event) => event.eventType === "linear.issue_completed");
    assert.equal(completedEvents.length, 1);
    assert.equal(completedEvents[0]?.title, "Status changed to Done");
    assert.equal(completedEvents[0]?.actorPersonId, "linear:user:user_carol");
    assert.equal(completedEvents[0]?.metadata?.["exactHistory"], true);
    assert.equal(completedEvents[0]?.metadata?.["fromState"], "In Progress");
  });

  it("normalizes comments and projects into activity records", () => {
    const comment = normalizeLinearComment(
      {
        id: "comment_1",
        body: "Looks ready.",
        createdAt: "2026-06-28T14:00:00.000Z",
        user: { id: "user_dana" },
        issue: { id: "lin_2" },
      },
      { workItemId: "linear:linear_issue:lin_2", linearTeamId: "team_eng" },
    );

    assert.equal(comment.eventType, "linear.issue_commented");
    assert.equal(comment.workItemId, "linear:linear_issue:lin_2");
    assert.equal(comment.actorPersonId, "linear:user:user_dana");

    const project = normalizeLinearProject({
      id: "project_1",
      name: "Onboarding",
      createdAt: "2026-06-01T09:00:00.000Z",
      completedAt: "2026-06-28T16:00:00.000Z",
      team: { id: "team_eng" },
    });

    assert.equal(project.workItem.sourceType, "linear_project");
    assert.equal(project.workItem.status, "completed");
    assert.deepEqual(project.events.map((event) => event.eventType), ["linear.project_created", "linear.project_completed"]);
    assert.equal(project.events[1]?.metadata?.["conservative"], true);
  });
});
