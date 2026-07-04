import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Highlight, ReportContext } from "../../src/analysis/types.js";
import { openLocalDatabase } from "../../src/db/index.js";
import {
  getAnalysisRun,
  getAnalysisRunForOrganization,
  getReportForOrganization,
  getReport,
  listAnalysisHighlights,
  listAnalysisHighlightsForOrganization,
  listAnalysisMetrics,
  listAnalysisMetricsForOrganization,
  listReportInputs,
  listReportInputsForOrganization,
  saveCompleteAnalysisResult,
  saveCompleteReportResult,
} from "../../src/persistence/index.js";

const context: ReportContext = {
  organization: { id: "org_1", name: "Acme" },
  scope: { type: "github_repository", id: "repo_1", name: "acme/widgets" },
  period: { start: "2026-06-22", end: "2026-06-29" },
  freshness: { github: "2026-06-29T09:00:00.000Z", warnings: [] },
  metrics: [{ name: "activity.events", value: 2, dimensions: { provider: "github" } }],
  highlights: [
    {
      title: "Merged billing export",
      reason: "PR merged during this period",
      sourceRefs: ["github:pr:42"],
      relatedPeople: ["person_1"],
      relatedWorkItems: ["work_1"],
    },
  ],
  people: [],
  workItems: [
    {
      id: "work_1",
      provider: "github",
      title: "Billing export",
      url: "https://github.com/acme/widgets/pull/42",
      status: "merged",
      summaryFacts: ["github github_pull_request is merged"],
    },
  ],
  risks: [],
};

const highlight: Highlight = {
  workItemId: "work_1",
  highlightType: "merged_pr",
  score: 9,
  title: "Merged billing export",
  reason: ["PR merged during this period"],
  sourceRefs: ["github:pr:42"],
  relatedPeople: ["person_1"],
  relatedWorkItems: ["work_1"],
};

describe("persistence repositories", () => {
  it("saves and reads a complete analysis result", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      insertOrganization(local.sqlite);
      insertWorkItem(local.sqlite);

      const saved = saveCompleteAnalysisResult(local.sqlite, {
        run: {
          id: "analysis_run_1",
          organizationId: "org_1",
          scopeType: "github_repository",
          scopeId: "repo_1",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          status: "completed",
          startedAt: "2026-06-29T09:00:00.000Z",
          finishedAt: "2026-06-29T09:01:00.000Z",
        },
        metrics: [{ id: "metric_1", name: "activity.events", value: 2, dimensions: { provider: "github" } }],
        highlights: [{ id: "highlight_1", ...highlight }],
        reportContext: {
          id: "report_context_1",
          context,
        },
      });

      assert.equal(saved.run.id, "analysis_run_1");
      assert.equal(saved.reportContext.context.scope.name, "acme/widgets");

      assert.deepEqual(listAnalysisMetrics(local.sqlite, "analysis_run_1"), [
        {
          id: "metric_1",
          organizationId: "org_1",
          analysisRunId: "analysis_run_1",
          scopeType: "github_repository",
          scopeId: "repo_1",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          name: "activity.events",
          value: 2,
          dimensions: { provider: "github" },
          createdAt: saved.metrics[0]?.createdAt,
        },
      ]);
      assert.deepEqual(listAnalysisHighlights(local.sqlite, "analysis_run_1")[0]?.sourceRefs, ["github:pr:42"]);
    } finally {
      local.close();
    }
  });

  it("saves and reads a complete report result with inputs", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      insertOrganization(local.sqlite);
      insertWorkItem(local.sqlite);
      const analysis = saveCompleteAnalysisResult(local.sqlite, {
        run: {
          id: "analysis_run_1",
          organizationId: "org_1",
          scopeType: "github_repository",
          scopeId: "repo_1",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          status: "completed",
          startedAt: "2026-06-29T09:00:00.000Z",
          finishedAt: "2026-06-29T09:01:00.000Z",
        },
        metrics: [{ id: "metric_1", name: "activity.events", value: 2 }],
        highlights: [{ id: "highlight_1", ...highlight }],
        reportContext: { id: "report_context_1", context },
      });

      const saved = saveCompleteReportResult(local.sqlite, {
        report: {
          id: "report_1",
          organizationId: "org_1",
          analysisReportContextId: analysis.reportContext.id,
          reportType: "weekly",
          scopeType: "github_repository",
          scopeId: "repo_1",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          status: "completed",
          title: "Weekly report: acme/widgets",
          summary: "Two observed events.",
          bodyMarkdown: "# Weekly report: acme/widgets\n",
          structured: { contextId: analysis.reportContext.id },
        },
        inputs: [
          {
            id: "report_input_1",
            inputType: "analysis_report_context",
            inputId: analysis.reportContext.id,
            metadata: { role: "primary" },
          },
          { id: "report_input_2", inputType: "analysis_metric", inputId: "metric_1" },
        ],
      });

      assert.equal(getReport(local.sqlite, "report_1")?.bodyMarkdown, "# Weekly report: acme/widgets\n");
      assert.deepEqual(
        listReportInputs(local.sqlite, saved.report.id).map((input) => ({
          inputType: input.inputType,
          inputId: input.inputId,
          metadata: input.metadata,
        })),
        [
          { inputType: "analysis_report_context", inputId: "report_context_1", metadata: { role: "primary" } },
          { inputType: "analysis_metric", inputId: "metric_1", metadata: {} },
        ],
      );
    } finally {
      local.close();
    }
  });

  it("rolls back a complete analysis result when a child insert fails", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      insertOrganization(local.sqlite);
      assert.throws(
        () =>
          saveCompleteAnalysisResult(local.sqlite, {
            run: {
              id: "analysis_run_1",
              organizationId: "org_1",
              scopeType: "github_repository",
              scopeId: "repo_1",
              periodStart: "2026-06-22",
              periodEnd: "2026-06-29",
              status: "completed",
              startedAt: "2026-06-29T09:00:00.000Z",
            },
            metrics: [{ id: "metric_1", name: "activity.events", value: 2 }],
            highlights: [{ id: "highlight_1", ...highlight }],
            reportContext: { id: "report_context_1", context },
          }),
        /FOREIGN KEY/,
      );

      assert.equal(getAnalysisRun(local.sqlite, "analysis_run_1"), undefined);
      assert.equal(listAnalysisMetrics(local.sqlite, "analysis_run_1").length, 0);
    } finally {
      local.close();
    }
  });

  it("keeps analysis and report reads scoped by organization", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      insertOrganization(local.sqlite, "org_1", "Acme", "acme");
      insertOrganization(local.sqlite, "org_2", "Beta", "beta");
      insertWorkItem(local.sqlite, "org_1", "work_1");
      insertWorkItem(local.sqlite, "org_2", "work_2");

      const org1Context = context;
      const org2Context: ReportContext = {
        ...context,
        organization: { id: "org_2", name: "Beta" },
        workItems: [{ ...context.workItems[0]!, id: "work_2", title: "Beta export" }],
      };

      const org1 = saveCompleteAnalysisResult(local.sqlite, {
        run: {
          id: "analysis_run_1",
          organizationId: "org_1",
          scopeType: "github_repository",
          scopeId: "repo_1",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          status: "completed",
          startedAt: "2026-06-29T09:00:00.000Z",
        },
        metrics: [{ id: "metric_1", name: "activity.events", value: 2 }],
        highlights: [{ id: "highlight_1", ...highlight }],
        reportContext: { id: "report_context_1", context: org1Context },
      });
      saveCompleteAnalysisResult(local.sqlite, {
        run: {
          id: "analysis_run_2",
          organizationId: "org_2",
          scopeType: "github_repository",
          scopeId: "repo_2",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          status: "completed",
          startedAt: "2026-06-29T09:00:00.000Z",
        },
        metrics: [{ id: "metric_2", name: "activity.events", value: 5 }],
        highlights: [{ id: "highlight_2", ...highlight, workItemId: "work_2" }],
        reportContext: { id: "report_context_2", context: org2Context },
      });

      const report = saveCompleteReportResult(local.sqlite, {
        report: {
          id: "report_1",
          organizationId: "org_1",
          analysisReportContextId: org1.reportContext.id,
          reportType: "weekly",
          scopeType: "github_repository",
          scopeId: "repo_1",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          status: "completed",
          title: "Weekly report: acme/widgets",
          bodyMarkdown: "# Weekly report: acme/widgets\n",
          structured: {},
        },
        inputs: [{ id: "report_input_1", inputType: "analysis_metric", inputId: "metric_1" }],
      });

      assert.equal(getAnalysisRunForOrganization(local.sqlite, "org_1", "analysis_run_1")?.id, "analysis_run_1");
      assert.equal(getAnalysisRunForOrganization(local.sqlite, "org_2", "analysis_run_1"), undefined);
      assert.deepEqual(
        listAnalysisMetricsForOrganization(local.sqlite, "org_1", "analysis_run_1").map((metric) => metric.id),
        ["metric_1"],
      );
      assert.deepEqual(listAnalysisHighlightsForOrganization(local.sqlite, "org_2", "analysis_run_1"), []);
      assert.equal(getReportForOrganization(local.sqlite, "org_1", report.report.id)?.id, "report_1");
      assert.equal(getReportForOrganization(local.sqlite, "org_2", report.report.id), undefined);
      assert.deepEqual(
        listReportInputsForOrganization(local.sqlite, "org_1", report.report.id).map((input) => input.id),
        ["report_input_1"],
      );
      assert.deepEqual(listReportInputsForOrganization(local.sqlite, "org_2", report.report.id), []);
    } finally {
      local.close();
    }
  });
});

function insertOrganization(
  database: { prepare(sql: string): { run(...values: unknown[]): unknown } },
  id = "org_1",
  name = "Acme",
  slug = "acme",
): void {
  database.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)").run(id, name, slug);
}

function insertWorkItem(
  database: { prepare(sql: string): { run(...values: unknown[]): unknown } },
  organizationId = "org_1",
  id = "work_1",
): void {
  database
    .prepare(
      `INSERT INTO work_items (
        id, organization_id, provider, source_type, external_id, title, status, work_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, organizationId, "github", "github.pull_request", id, "Billing export", "merged", "github_pull_request");
}
