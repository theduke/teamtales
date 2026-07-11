import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { ReportScopeType } from "@teamtales/common/domain";
import { activityEvents, organizations, people, workItems } from "../../src/db/schema.js";
import { resolveReportContext } from "../../src/services/report-contexts.js";
import { mysqlTestOptions, openTestDatabase, uniqueId } from "../helpers/mysql.js";

describe("report context service", mysqlTestOptions, () => {
  it("filters database-derived contexts by requested scope", async () => {
    const opened = await openTestDatabase(); const suffix = uniqueId("context"), organizationId = `org_${suffix}`;
    try {
      await opened.db.insert(organizations).values({ id: organizationId, name: "Scoped Org", slug: organizationId });
      const cases: Array<{ scopeType: ReportScopeType; scopeId: string; personId: string; workItemId: string; columns: Record<string, string> }> = [
        { scopeType: "github_repository", scopeId: `repo_${suffix}`, personId: `person_repo_${suffix}`, workItemId: `work_repo_${suffix}`, columns: { repositoryId: `repo_${suffix}` } },
        { scopeType: "linear_team", scopeId: `team_${suffix}`, personId: `person_team_${suffix}`, workItemId: `work_team_${suffix}`, columns: { linearTeamId: `team_${suffix}` } },
        { scopeType: "linear_project", scopeId: `project_${suffix}`, personId: `person_project_${suffix}`, workItemId: `work_project_${suffix}`, columns: { linearProjectId: `project_${suffix}` } },
        { scopeType: "person", scopeId: `person_selected_${suffix}`, personId: `person_selected_${suffix}`, workItemId: `work_person_${suffix}`, columns: {} },
      ];
      await opened.db.insert(people).values(cases.map(item => ({ id: item.personId, organizationId, displayName: item.personId })));
      await opened.db.insert(workItems).values(cases.map((item, index) => ({ id: item.workItemId, organizationId, provider: index ? "linear" : "github", sourceType: "issue", externalId: item.workItemId, title: item.workItemId, status: "completed", workType: index ? "linear_issue" : "github_issue", completedAt: "2026-06-28T12:00:00.000Z" })));
      await opened.db.insert(activityEvents).values(cases.map((item, index) => ({ id: `event_${index}_${suffix}`, organizationId, provider: index ? "linear" : "github", eventType: "work.updated", actorPersonId: item.personId, workItemId: item.workItemId, ...item.columns, occurredAt: "2026-06-28T12:00:00.000Z", title: item.workItemId, metadataJson: "{}" })));
      for (const item of cases) {
        const resolved = await resolveReportContext(opened.db, { organizationId, organizationName: "Scoped Org", scopeType: item.scopeType, scopeId: item.scopeId, periodStart: "2026-06-22", periodEnd: "2026-06-29" });
        assert.equal(resolved.context.metrics.find(metric => metric.name === "activity.work.updated")?.value, 1);
        assert.deepEqual(resolved.context.people.map(person => person.personId), [item.personId]);
        assert.deepEqual(resolved.context.workItems.map(workItem => workItem.id), [item.workItemId]);
      }
    } finally { await opened.db.delete(organizations).where(eq(organizations.id, organizationId)); await opened.close(); }
  });
});
