import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { Highlight, ReportContext } from "../../src/analysis/types.js";
import { organizations, workItems } from "../../src/db/schema.js";
import {
  getAnalysisRun,
  getAnalysisRunForOrganization,
  getReport,
  getReportForOrganization,
  listAnalysisHighlights,
  listAnalysisHighlightsForOrganization,
  listAnalysisMetrics,
  listAnalysisMetricsForOrganization,
  listReportInputs,
  listReportInputsForOrganization,
  saveCompleteAnalysisResult,
  saveCompleteReportResult,
} from "../../src/persistence/index.js";
import type { SaveCompleteAnalysisResultInput } from "../../src/persistence/index.js";
import { mysqlTestOptions, openTestDatabase, uniqueId } from "../helpers/mysql.js";

describe("persistence repositories", mysqlTestOptions, () => {
  it("saves and reads complete analysis and report results asynchronously", async () => {
    const opened = await openTestDatabase();
    const suffix = uniqueId("persist"),
      organizationId = `org_${suffix}`,
      workItemId = `work_${suffix}`;
    try {
      await seed(opened.db, organizationId, workItemId);
      const context = reportContext(organizationId, workItemId);
      const ids = testIds(suffix);
      const analysis = await saveCompleteAnalysisResult(
        opened.db,
        analysisInput(ids, organizationId, context, workItemId),
      );
      assert.equal(analysis.run.id, ids.run);
      assert.deepEqual((await listAnalysisMetrics(opened.db, ids.run))[0]?.dimensions, {
        provider: "github",
      });
      assert.deepEqual((await listAnalysisHighlights(opened.db, ids.run))[0]?.sourceRefs, [
        "github:pr:42",
      ]);
      const saved = await saveCompleteReportResult(opened.db, {
        report: {
          id: ids.report,
          organizationId,
          analysisReportContextId: ids.context,
          reportType: "weekly",
          scopeType: "github_repository",
          scopeId: "repo_1",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          status: "completed",
          title: "Weekly report",
          bodyMarkdown: "# Weekly report\n",
          structured: { contextId: ids.context },
        },
        inputs: [
          {
            id: ids.input,
            inputType: "analysis_report_context",
            inputId: ids.context,
            metadata: { role: "primary" },
          },
        ],
      });
      assert.equal((await getReport(opened.db, ids.report))?.bodyMarkdown, "# Weekly report\n");
      assert.deepEqual((await listReportInputs(opened.db, saved.report.id))[0]?.metadata, {
        role: "primary",
      });
    } finally {
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.close();
    }
  });

  it("rolls back a complete analysis result when a child insert fails", async () => {
    const opened = await openTestDatabase();
    const suffix = uniqueId("rollback"),
      organizationId = `org_${suffix}`,
      workItemId = `work_${suffix}`;
    try {
      await seed(opened.db, organizationId, workItemId);
      const ids = testIds(suffix);
      const base = analysisInput(
        ids,
        organizationId,
        reportContext(organizationId, workItemId),
        workItemId,
      );
      const input: SaveCompleteAnalysisResultInput = {
        ...base,
        metrics: [...base.metrics, { ...base.metrics[0]!, id: ids.metric }],
      };
      await assertMySqlRejects(
        () => saveCompleteAnalysisResult(opened.db, input),
        "duplicate|unique",
      );
      assert.equal(await getAnalysisRun(opened.db, ids.run), undefined);
      assert.equal((await listAnalysisMetrics(opened.db, ids.run)).length, 0);
    } finally {
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.close();
    }
  });

  it("keeps analysis and report reads scoped by organization", async () => {
    const opened = await openTestDatabase();
    const suffix = uniqueId("tenant"),
      org1 = `org1_${suffix}`,
      org2 = `org2_${suffix}`,
      work1 = `work1_${suffix}`,
      work2 = `work2_${suffix}`;
    try {
      await seed(opened.db, org1, work1);
      await seed(opened.db, org2, work2);
      const one = testIds(`one_${suffix}`),
        two = testIds(`two_${suffix}`);
      await saveCompleteAnalysisResult(
        opened.db,
        analysisInput(one, org1, reportContext(org1, work1), work1),
      );
      await saveCompleteAnalysisResult(
        opened.db,
        analysisInput(two, org2, reportContext(org2, work2), work2),
      );
      await saveCompleteReportResult(opened.db, {
        report: {
          id: one.report,
          organizationId: org1,
          analysisReportContextId: one.context,
          reportType: "weekly",
          scopeType: "organization",
          scopeId: org1,
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          status: "completed",
          title: "One",
          bodyMarkdown: "# One",
          structured: {},
        },
        inputs: [{ id: one.input, inputType: "analysis_report_context", inputId: one.context }],
      });
      assert.equal((await getAnalysisRunForOrganization(opened.db, org1, one.run))?.id, one.run);
      assert.equal(await getAnalysisRunForOrganization(opened.db, org2, one.run), undefined);
      assert.equal((await listAnalysisMetricsForOrganization(opened.db, org2, one.run)).length, 0);
      assert.equal(
        (await listAnalysisHighlightsForOrganization(opened.db, org2, one.run)).length,
        0,
      );
      assert.equal((await getReportForOrganization(opened.db, org1, one.report))?.id, one.report);
      assert.equal(await getReportForOrganization(opened.db, org2, one.report), undefined);
      assert.equal((await listReportInputsForOrganization(opened.db, org2, one.report)).length, 0);
    } finally {
      await opened.db.delete(organizations).where(eq(organizations.id, org1));
      await opened.db.delete(organizations).where(eq(organizations.id, org2));
      await opened.close();
    }
  });
});

async function assertMySqlRejects(action: () => Promise<unknown>, pattern: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    const expression = new RegExp(pattern, "i");
    let current = error;
    while (current instanceof Error) {
      if (expression.test(current.message)) return true;
      current = (current as Error & { cause?: unknown }).cause;
    }
    return false;
  });
}

function testIds(suffix: string) {
  return {
    run: `run_${suffix}`,
    metric: `metric_${suffix}`,
    highlight: `highlight_${suffix}`,
    context: `context_${suffix}`,
    report: `report_${suffix}`,
    input: `input_${suffix}`,
  };
}
function reportContext(organizationId: string, workItemId: string): ReportContext {
  return {
    organization: { id: organizationId, name: organizationId },
    scope: { type: "github_repository", id: "repo_1", name: "acme/widgets" },
    period: { start: "2026-06-22", end: "2026-06-29" },
    freshness: { warnings: [] },
    metrics: [{ name: "activity.events", value: 2 }],
    highlights: [
      {
        title: "Merged billing export",
        reason: "PR merged",
        sourceRefs: ["github:pr:42"],
        relatedPeople: [],
        relatedWorkItems: [workItemId],
      },
    ],
    people: [],
    workItems: [
      {
        id: workItemId,
        provider: "github",
        title: "Billing export",
        url: "https://github.com/acme/widgets/pull/42",
        status: "merged",
        summaryFacts: [],
      },
    ],
    risks: [],
  };
}
function analysisInput(
  ids: ReturnType<typeof testIds>,
  organizationId: string,
  context: ReportContext,
  workItemId: string,
): SaveCompleteAnalysisResultInput {
  const highlight: Highlight = {
    workItemId,
    highlightType: "merged_pr",
    score: 9,
    title: "Merged billing export",
    reason: ["PR merged"],
    sourceRefs: ["github:pr:42"],
    relatedPeople: [],
    relatedWorkItems: [workItemId],
  };
  return {
    run: {
      id: ids.run,
      organizationId,
      scopeType: "github_repository",
      scopeId: "repo_1",
      periodStart: "2026-06-22",
      periodEnd: "2026-06-29",
      status: "completed",
      startedAt: "2026-06-29T09:00:00.000Z",
    },
    metrics: [
      { id: ids.metric, name: "activity.events", value: 2, dimensions: { provider: "github" } },
    ],
    highlights: [{ id: ids.highlight, ...highlight }],
    reportContext: { id: ids.context, context },
  };
}
async function seed(
  db: Awaited<ReturnType<typeof openTestDatabase>>["db"],
  organizationId: string,
  workItemId: string,
) {
  await db
    .insert(organizations)
    .values({ id: organizationId, name: organizationId, slug: organizationId });
  await db.insert(workItems).values({
    id: workItemId,
    organizationId,
    provider: "github",
    sourceType: "pull_request",
    externalId: workItemId,
    title: workItemId,
    status: "merged",
    workType: "github_pull_request",
  });
}
