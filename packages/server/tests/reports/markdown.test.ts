import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReportContext } from "../../src/analysis/types.js";
import { generateWeeklyMarkdownReport } from "../../src/reports/markdown.js";

const emptyContext: ReportContext = {
  organization: { id: "org_1", name: "Acme" },
  scope: { type: "github_repository", id: "repo_1", name: "acme/widgets" },
  period: { start: "2026-06-22", end: "2026-06-29" },
  freshness: { warnings: [] },
  metrics: [],
  highlights: [],
  people: [],
  workItems: [],
  risks: [],
};

describe("generateWeeklyMarkdownReport", () => {
  it("generates deterministic markdown for an empty weekly context", () => {
    assert.equal(
      generateWeeklyMarkdownReport(emptyContext),
      `# Weekly report: acme/widgets

Organization: Acme
Scope: acme/widgets (github_repository)
Period: 2026-06-22 to 2026-06-29

## Summary

- This report is based on the provided report context: 0 observed highlights, 0 people with observed activity, 0 tracked work items, 0 possible risks.

## Data freshness

- No freshness timestamps or warnings were provided.

## Metrics

- No metrics were provided.

## Observed highlights

- No highlights were provided.

## Possible themes

- No possible themes were derived from the provided context.

## People

- No people activity summaries were provided.

## Work items

- No work items were provided.

## Possible risks

- No possible risks were provided.
`,
    );
  });

  it("uses only provided context facts and cautious risk/theme wording", () => {
    const context: ReportContext = {
      ...emptyContext,
      freshness: {
        github: "2026-06-29T09:00:00.000Z",
        linear: "2026-06-29T08:00:00.000Z",
        warnings: ["Linear sync skipped archived projects"],
      },
      metrics: [
        { name: "activity.events", value: 8 },
        { name: "work.items", value: 2, dimensions: { status: "merged", provider: "github" } },
      ],
      highlights: [
        {
          title: "Merged billing export",
          reason: "PR merged during this period",
          sourceRefs: ["github:pr:42"],
          relatedPeople: ["person_1"],
          relatedWorkItems: ["work_1"],
        },
      ],
      people: [
        {
          personId: "person_1",
          displayName: "Sam Rivera",
          activitySummary: "Sam Rivera had 5 observed activity events in this period.",
          metrics: { "activity.events": 5, "github.pr.merged": 1 },
          sourceRefs: ["github:event:2", "github:event:1"],
        },
      ],
      workItems: [
        {
          id: "work_2",
          provider: "linear",
          title: "Investigate flaky webhook",
          url: "",
          status: "in_progress",
          summaryFacts: ["linear linear_issue is in_progress"],
        },
        {
          id: "work_1",
          provider: "github",
          title: "Billing export",
          url: "https://github.com/acme/widgets/pull/42",
          status: "merged",
          summaryFacts: ["github github_pull_request is merged", "Merged pull request"],
        },
      ],
      risks: [
        {
          title: "Webhook investigation remains active",
          reason: "Item is still in progress",
          sourceRefs: ["linear:issue:7"],
        },
      ],
    };

    const markdown = generateWeeklyMarkdownReport(context);

    assert.match(markdown, /- Completion may be a theme: 1 tracked work item is marked completed or merged\./);
    assert.match(markdown, /- Active work may be a theme: 1 tracked work item remains open or in progress\./);
    assert.match(markdown, /- Possible risk: Webhook investigation remains active\. Context reason: Item is still in progress Sources: linear:issue:7\./);
    assert.match(markdown, /- \[Billing export\]\(https:\/\/github.com\/acme\/widgets\/pull\/42\): github, merged\. Facts: github github_pull_request is merged; Merged pull request/);
    assert.doesNotMatch(markdown, /successfully delivered|blocked the team|root cause|customer impact/i);
  });

  it("is stable when input arrays are reordered", () => {
    const left: ReportContext = {
      ...emptyContext,
      metrics: [
        { name: "z.metric", value: 1 },
        { name: "a.metric", value: 2 },
      ],
      risks: [
        { title: "Second", reason: "Observed second", sourceRefs: ["b"] },
        { title: "First", reason: "Observed first", sourceRefs: ["a"] },
      ],
    };
    const right: ReportContext = {
      ...left,
      metrics: [...left.metrics].reverse(),
      risks: [...left.risks].reverse(),
    };

    assert.equal(generateWeeklyMarkdownReport(left), generateWeeklyMarkdownReport(right));
  });
});
