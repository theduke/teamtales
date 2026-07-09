import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReportContext } from "@teamtales/common/domain";

import { openLocalDatabase } from "../../src/db/index.js";
import { listAnalysisHighlights } from "../../src/persistence/index.js";
import { generateWeeklyReportService } from "../../src/services/reports.js";

describe("report service", () => {
  it("persists generated analysis highlights from the report context", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      local.sqlite
        .prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)")
        .run("org_report", "Report Org", "report");
      local.sqlite
        .prepare(
          `INSERT INTO work_items (
            id, organization_id, provider, source_type, external_id, title, status, work_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "work_report",
          "org_report",
          "github",
          "pull_request",
          "42",
          "Merged report work",
          "merged",
          "github_pull_request",
        );

      const generated = generateWeeklyReportService(local.sqlite, {
        context: reportContext,
        persist: true,
        analysisRunIdSeed: "test",
      });
      const analysisRunId = local.sqlite
        .prepare("SELECT analysis_run_id FROM analysis_report_contexts WHERE id = ?")
        .get(generated.analysisReportContextId) as { analysis_run_id: string };
      const highlights = listAnalysisHighlights(local.sqlite, analysisRunId.analysis_run_id);

      assert.equal(highlights.length, 1);
      assert.equal(highlights[0]?.title, "Merged report work");
      assert.equal(highlights[0]?.workItemId, "work_report");
      assert.equal(highlights[0]?.highlightType, "merged_pr");
      assert.deepEqual(highlights[0]?.sourceRefs, ["github:pr:42"]);
      assert.equal(highlights[0]?.id, "highlight_e8bf7082566dcf0e");
    } finally {
      local.close();
    }
  });
});

const reportContext: ReportContext = {
  organization: { id: "org_report", name: "Report Org" },
  scope: { type: "github_repository", id: "repo_report", name: "acme/report" },
  period: { start: "2026-06-22", end: "2026-06-29" },
  freshness: { warnings: [] },
  metrics: [{ name: "activity.events", value: 1 }],
  highlights: [
    {
      title: "Merged report work",
      reason: "Pull request merged during this period",
      sourceRefs: ["github:pr:42"],
      relatedPeople: ["person_report"],
      relatedWorkItems: ["work_report"],
    },
  ],
  people: [],
  workItems: [
    {
      id: "work_report",
      provider: "github",
      title: "Merged report work",
      url: "https://github.com/acme/report/pull/42",
      status: "merged",
      summaryFacts: ["github github_pull_request is merged"],
    },
  ],
  risks: [],
};
