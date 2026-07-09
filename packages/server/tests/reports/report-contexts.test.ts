import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReportScopeType } from "@teamtales/common/domain";

import { openLocalDatabase } from "../../src/db/index.js";
import { resolveReportContext } from "../../src/services/report-contexts.js";

describe("report context service", () => {
  it("filters database-derived contexts by requested scope", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      seedScopedActivity(local.sqlite);

      assertScopedContext(local.sqlite, "github_repository", "repo_keep", {
        metrics: 1,
        people: ["person_repo"],
        workItems: ["work_repo"],
      });
      assertScopedContext(local.sqlite, "linear_team", "team_keep", {
        metrics: 1,
        people: ["person_team"],
        workItems: ["work_team"],
      });
      assertScopedContext(local.sqlite, "linear_project", "project_keep", {
        metrics: 1,
        people: ["person_project"],
        workItems: ["work_project"],
      });
      assertScopedContext(local.sqlite, "person", "person_keep", {
        metrics: 1,
        people: ["person_keep"],
        workItems: ["work_person"],
      });
    } finally {
      local.close();
    }
  });
});

function assertScopedContext(
  database: import("node:sqlite").DatabaseSync,
  scopeType: ReportScopeType,
  scopeId: string,
  expected: { metrics: number; people: string[]; workItems: string[] },
): void {
  const resolved = resolveReportContext(database, {
    organizationId: "org_scope",
    organizationName: "Scoped Org",
    scopeType,
    scopeId,
    periodStart: "2026-06-22",
    periodEnd: "2026-06-29",
  });

  assert.equal(
    resolved.context.metrics.find((metric) => metric.name === "activity.work.updated")?.value,
    expected.metrics,
  );
  assert.deepEqual(resolved.context.people.map((person) => person.personId), expected.people);
  assert.deepEqual(resolved.context.workItems.map((workItem) => workItem.id), expected.workItems);
}

function seedScopedActivity(database: import("node:sqlite").DatabaseSync): void {
  database.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)").run("org_scope", "Scoped Org", "scoped");

  for (const [id, name] of [
    ["person_repo", "Repo Person"],
    ["person_team", "Team Person"],
    ["person_project", "Project Person"],
    ["person_keep", "Selected Person"],
    ["person_other", "Other Person"],
  ]) {
    database.prepare("INSERT INTO people (id, organization_id, display_name) VALUES (?, ?, ?)").run(id, "org_scope", name);
  }

  for (const id of ["work_repo", "work_team", "work_project", "work_person", "work_other"]) {
    const isGitHub = id === "work_repo";
    database
      .prepare(
        `INSERT INTO work_items (
          id, organization_id, provider, source_type, external_id, title, status, work_type, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        "org_scope",
        isGitHub ? "github" : "linear",
        "issue",
        id,
        id,
        "completed",
        isGitHub ? "github_issue" : "linear_issue",
        "2026-06-28T12:00:00.000Z",
      );
  }

  insertEvent(database, {
    id: "event_repo",
    personId: "person_repo",
    workItemId: "work_repo",
    repositoryId: "repo_keep",
  });
  insertEvent(database, {
    id: "event_team",
    personId: "person_team",
    workItemId: "work_team",
    linearTeamId: "team_keep",
  });
  insertEvent(database, {
    id: "event_project",
    personId: "person_project",
    workItemId: "work_project",
    linearProjectId: "project_keep",
  });
  insertEvent(database, {
    id: "event_person",
    personId: "person_keep",
    workItemId: "work_person",
    repositoryId: "repo_other",
    linearTeamId: "team_other",
    linearProjectId: "project_other",
  });
  insertEvent(database, {
    id: "event_other",
    personId: "person_other",
    workItemId: "work_other",
    repositoryId: "repo_other",
    linearTeamId: "team_other",
    linearProjectId: "project_other",
  });
}

function insertEvent(
  database: import("node:sqlite").DatabaseSync,
  event: {
    id: string;
    personId: string;
    workItemId: string;
    repositoryId?: string;
    linearTeamId?: string;
    linearProjectId?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO activity_events (
        id, organization_id, provider, event_type, actor_person_id, work_item_id,
        repository_id, linear_team_id, linear_project_id, occurred_at, title, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      "org_scope",
      event.repositoryId === undefined ? "linear" : "github",
      "work.updated",
      event.personId,
      event.workItemId,
      event.repositoryId ?? null,
      event.linearTeamId ?? null,
      event.linearProjectId ?? null,
      "2026-06-28T12:00:00.000Z",
      event.id,
      "{}",
    );
}
