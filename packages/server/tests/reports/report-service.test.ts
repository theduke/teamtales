import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { ReportContext } from "@teamtales/common/domain";
import { analysisReportContexts, organizations, workItems } from "../../src/db/schema.js";
import { listAnalysisHighlights } from "../../src/persistence/index.js";
import { generateWeeklyReportService } from "../../src/services/reports.js";
import { mysqlTestOptions, openTestDatabase, uniqueId } from "../helpers/mysql.js";

describe("report service", mysqlTestOptions, () => {
  it("persists generated analysis highlights from the report context", async () => {
    const opened = await openTestDatabase(); const suffix = uniqueId("report"), organizationId = `org_${suffix}`, workItemId = `work_${suffix}`;
    const context: ReportContext = { organization: { id: organizationId, name: "Report Org" }, scope: { type: "github_repository", id: `repo_${suffix}`, name: "acme/report" }, period: { start: "2026-06-22", end: "2026-06-29" }, freshness: { warnings: [] }, metrics: [{ name: "activity.events", value: 1 }], highlights: [{ title: "Merged report work", reason: "Pull request merged during this period", sourceRefs: ["github:pr:42"], relatedPeople: [], relatedWorkItems: [workItemId] }], people: [], workItems: [{ id: workItemId, provider: "github", title: "Merged report work", url: "https://github.com/acme/report/pull/42", status: "merged", summaryFacts: ["github github_pull_request is merged"] }], risks: [] };
    try {
      await opened.db.insert(organizations).values({ id: organizationId, name: "Report Org", slug: organizationId });
      await opened.db.insert(workItems).values({ id: workItemId, organizationId, provider: "github", sourceType: "pull_request", externalId: "42", title: "Merged report work", status: "merged", workType: "github_pull_request" });
      const generated = await generateWeeklyReportService(opened.db, { context, persist: true, analysisRunIdSeed: suffix });
      const [storedContext] = await opened.db.select().from(analysisReportContexts).where(eq(analysisReportContexts.id, generated.analysisReportContextId));
      const highlights = await listAnalysisHighlights(opened.db, storedContext!.analysisRunId);
      assert.equal(highlights.length, 1); assert.equal(highlights[0]?.workItemId, workItemId); assert.equal(highlights[0]?.highlightType, "merged_pr"); assert.deepEqual(highlights[0]?.sourceRefs, ["github:pr:42"]);
    } finally { await opened.db.delete(organizations).where(eq(organizations.id, organizationId)); await opened.close(); }
  });
});
