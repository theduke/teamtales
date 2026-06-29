import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import {
  buildReportContext,
  computeActivityMetrics,
  eventsInPeriod,
  scoreHighlights,
  type ActivityEvent,
  type AnalysisInput,
  type Person,
  type WorkItem,
} from "../../src/analysis/index.js";
import { openLocalDatabase } from "../../src/db/index.js";
import { hashCanonicalJson, type JsonValue } from "../../src/ingestion/json.js";
import type { Provider } from "../../src/ingestion/providers.js";
import type { SourceObjectType } from "../../src/ingestion/source-object.js";
import {
  normalizeGitHubIssueComment,
  normalizeGitHubPullRequest,
  normalizeGitHubPullRequestReview,
  normalizeLinearComment,
  normalizeLinearIssue,
  type NormalizationContext,
  type SourceRecord,
} from "../../src/normalization/index.js";
import {
  getAnalysisReportContext,
  getAnalysisRun,
  getReport,
  listAnalysisHighlights,
  listAnalysisMetrics,
  listReportInputs,
  saveCompleteAnalysisResult,
  saveCompleteReportResult,
} from "../../src/persistence/index.js";
import { generateWeeklyMarkdownReport } from "../../src/reports/index.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/e2e/source-to-report.json");

describe("source-to-report fixture flow", () => {
  it("normalizes GitHub and Linear source objects into a deterministic persisted markdown report", () => {
    const fixture = loadFixture();
    const local = openLocalDatabase({ runMigrations: true });

    try {
      seedIntegrationRows(local.sqlite, fixture);
      insertPeople(local.sqlite, fixture.organization.id, fixture.people);

      const normalized = normalizeFixtureSourceObjects(fixture.sourceObjects);
      for (const source of fixture.sourceObjects) {
        insertSourceObject(local.sqlite, fixture.organization.id, source);
      }
      for (const workItem of normalized.workItems) {
        insertWorkItem(local.sqlite, fixture.organization.id, workItem, normalized.sourceObjectByWorkItem.get(workItem.id));
      }
      for (const event of normalized.events) {
        insertActivityEvent(local.sqlite, fixture.organization.id, event, normalized.sourceObjectByEvent.get(event.id));
      }

      const periodEvents = eventsInPeriod(normalized.events, fixture.period.start, fixture.period.end);
      const metrics = computeActivityMetrics(periodEvents);
      const highlights = scoreHighlights(normalized.workItems, periodEvents, {
        periodStart: fixture.period.start,
        periodEnd: fixture.period.end,
      });
      const analysisInput: AnalysisInput = {
        organization: fixture.organization,
        scope: fixture.scope,
        period: fixture.period,
        freshness: fixture.freshness,
        people: fixture.people,
        workItems: normalized.workItems,
        events: normalized.events,
      };
      const reportContext = buildReportContext(analysisInput);
      assert.deepEqual(buildReportContext(analysisInput), reportContext);

      const analysis = saveCompleteAnalysisResult(local.sqlite, {
        run: {
          id: "analysis_run_fixture",
          organizationId: fixture.organization.id,
          scopeType: fixture.scope.type,
          scopeId: fixture.scope.id,
          periodStart: fixture.period.start,
          periodEnd: fixture.period.end,
          status: "completed",
          startedAt: "2026-06-29T09:00:00.000Z",
          finishedAt: "2026-06-29T09:00:05.000Z",
        },
        metrics: metrics.map((metric, index) => ({ id: `analysis_metric_${index + 1}`, ...metric })),
        highlights: highlights.map((highlight, index) => ({ id: `analysis_highlight_${index + 1}`, ...highlight })),
        reportContext: {
          id: "analysis_report_context_fixture",
          context: reportContext,
        },
      });

      const markdown = generateWeeklyMarkdownReport(analysis.reportContext.context, {
        title: "Weekly fixture report",
      });
      assert.equal(generateWeeklyMarkdownReport(analysis.reportContext.context, { title: "Weekly fixture report" }), markdown);
      assert.match(markdown, /^# Weekly fixture report\n/);
      assert.match(markdown, /Ship customer export/);
      assert.match(markdown, /Finish onboarding checklist/);
      assert.match(markdown, /github\.prs_merged: 1/);
      assert.match(markdown, /linear\.issues_completed: 1/);

      const report = saveCompleteReportResult(local.sqlite, {
        report: {
          id: "report_fixture",
          organizationId: fixture.organization.id,
          analysisReportContextId: analysis.reportContext.id,
          reportType: "weekly",
          scopeType: fixture.scope.type,
          scopeId: fixture.scope.id,
          periodStart: fixture.period.start,
          periodEnd: fixture.period.end,
          status: "completed",
          title: "Weekly fixture report",
          summary: "Fixture source objects produced deterministic analysis and markdown.",
          bodyMarkdown: markdown,
          structured: {
            analysisRunId: analysis.run.id,
            analysisReportContextId: analysis.reportContext.id,
            metricCount: analysis.metrics.length,
            highlightCount: analysis.highlights.length,
          },
        },
        inputs: [
          {
            id: "report_input_context",
            inputType: "analysis_report_context",
            inputId: analysis.reportContext.id,
            metadata: { role: "primary" },
          },
          ...analysis.metrics.map((metric, index) => ({
            id: `report_input_metric_${index + 1}`,
            inputType: "analysis_metric" as const,
            inputId: metric.id,
          })),
          ...analysis.highlights.map((highlight, index) => ({
            id: `report_input_highlight_${index + 1}`,
            inputType: "analysis_highlight" as const,
            inputId: highlight.id,
          })),
          ...normalized.workItems.map((workItem, index) => ({
            id: `report_input_work_item_${index + 1}`,
            inputType: "work_item" as const,
            inputId: workItem.id,
          })),
          ...normalized.events.map((event, index) => ({
            id: `report_input_activity_event_${index + 1}`,
            inputType: "activity_event" as const,
            inputId: event.id,
          })),
          ...fixture.sourceObjects.map((source, index) => ({
            id: `report_input_source_object_${index + 1}`,
            inputType: "source_object" as const,
            inputId: source.id,
          })),
        ],
      });

      assert.equal(getAnalysisRun(local.sqlite, "analysis_run_fixture")?.status, "completed");
      assert.deepEqual(getAnalysisReportContext(local.sqlite, "analysis_report_context_fixture")?.context, reportContext);
      assert.equal(listAnalysisMetrics(local.sqlite, "analysis_run_fixture").length, metrics.length);
      assert.deepEqual(
        listAnalysisMetrics(local.sqlite, "analysis_run_fixture").map((metric) => [metric.name, metric.value]),
        metrics.map((metric) => [metric.name, metric.value]),
      );
      assert.equal(listAnalysisHighlights(local.sqlite, "analysis_run_fixture").length, highlights.length);
      assert.equal(getReport(local.sqlite, "report_fixture")?.bodyMarkdown, markdown);
      assert.equal(listReportInputs(local.sqlite, report.report.id).length, report.inputs.length);
      assert.equal(countRows(local.sqlite, "source_objects"), fixture.sourceObjects.length);
      assert.equal(countRows(local.sqlite, "work_items"), normalized.workItems.length);
      assert.equal(countRows(local.sqlite, "activity_events"), normalized.events.length);
    } finally {
      local.close();
    }
  });
});

type Fixture = {
  organization: AnalysisInput["organization"];
  period: AnalysisInput["period"];
  scope: AnalysisInput["scope"];
  freshness: NonNullable<AnalysisInput["freshness"]>;
  people: Person[];
  sourceObjects: FixtureSourceObject[];
};

type FixtureSourceObject = {
  id: string;
  integrationId: string;
  syncScopeId: string;
  provider: Provider;
  objectType: SourceObjectType;
  externalId: string;
  externalUrl?: string;
  externalCreatedAt?: string;
  externalUpdatedAt?: string;
  normalization?: NormalizationContext;
  raw: SourceRecord;
};

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
}

function seedIntegrationRows(database: DatabaseSync, fixture: Fixture): void {
  database
    .prepare(
      `INSERT INTO integrations (id, organization_id, provider, auth_type, status, display_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("integration_github", fixture.organization.id, "github", "personal_access_token", "active", "Fixture GitHub");
  database
    .prepare(
      `INSERT INTO integrations (id, organization_id, provider, auth_type, status, display_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("integration_linear", fixture.organization.id, "linear", "personal_access_token", "active", "Fixture Linear");
  database
    .prepare(
      `INSERT INTO sync_scopes (
        id, organization_id, integration_id, provider, scope_type, external_id, external_name,
        last_success_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "scope_github_widgets",
      fixture.organization.id,
      "integration_github",
      "github",
      "repository",
      "fixtureco/widgets",
      "fixtureco/widgets",
      fixture.freshness.github,
    );
  database
    .prepare(
      `INSERT INTO sync_scopes (
        id, organization_id, integration_id, provider, scope_type, external_id, external_name,
        last_success_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "scope_linear_workspace",
      fixture.organization.id,
      "integration_linear",
      "linear",
      "workspace",
      "fixture-linear",
      "Fixture Linear",
      fixture.freshness.linear,
    );
}

function insertPeople(database: DatabaseSync, organizationId: string, people: readonly Person[]): void {
  const statement = database.prepare("INSERT INTO people (id, organization_id, display_name) VALUES (?, ?, ?)");
  for (const person of people) {
    statement.run(person.id, organizationId, person.displayName);
  }
}

function normalizeFixtureSourceObjects(sourceObjects: readonly FixtureSourceObject[]): {
  workItems: WorkItem[];
  events: ActivityEvent[];
  sourceObjectByWorkItem: Map<string, string>;
  sourceObjectByEvent: Map<string, string>;
} {
  const workItems: WorkItem[] = [];
  const events: ActivityEvent[] = [];
  const sourceObjectByWorkItem = new Map<string, string>();
  const sourceObjectByEvent = new Map<string, string>();

  for (const source of sourceObjects) {
    const context = { ...source.normalization, sourceObjectId: source.id };

    if (source.objectType === "github.pull_request") {
      const result = normalizeGitHubPullRequest(source.raw, context);
      workItems.push(result.workItem);
      events.push(...result.events);
      sourceObjectByWorkItem.set(result.workItem.id, source.id);
      for (const event of result.events) {
        sourceObjectByEvent.set(event.id, source.id);
      }
      continue;
    }

    if (source.objectType === "github.pull_request_review") {
      const event = normalizeGitHubPullRequestReview(source.raw, context);
      events.push(event);
      sourceObjectByEvent.set(event.id, source.id);
      continue;
    }

    if (source.objectType === "github.issue_comment") {
      const event = normalizeGitHubIssueComment(source.raw, context);
      events.push(event);
      sourceObjectByEvent.set(event.id, source.id);
      continue;
    }

    if (source.objectType === "linear.issue") {
      const result = normalizeLinearIssue(source.raw, context);
      workItems.push(result.workItem);
      events.push(...result.events);
      sourceObjectByWorkItem.set(result.workItem.id, source.id);
      for (const event of result.events) {
        sourceObjectByEvent.set(event.id, source.id);
      }
      continue;
    }

    if (source.objectType === "linear.comment") {
      const event = normalizeLinearComment(source.raw, context);
      events.push(event);
      sourceObjectByEvent.set(event.id, source.id);
    }
  }

  return { workItems, events, sourceObjectByWorkItem, sourceObjectByEvent };
}

function insertSourceObject(database: DatabaseSync, organizationId: string, source: FixtureSourceObject): void {
  const seenAt = "2026-06-29T08:00:00.000Z";
  database
    .prepare(
      `INSERT INTO source_objects (
        id, organization_id, integration_id, sync_scope_id, provider, object_type, external_id,
        external_url, external_created_at, external_updated_at, raw_json, content_hash,
        first_seen_at, last_seen_at, last_changed_at, source_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      source.id,
      organizationId,
      source.integrationId,
      source.syncScopeId,
      source.provider,
      source.objectType,
      source.externalId,
      source.externalUrl ?? null,
      source.externalCreatedAt ?? null,
      source.externalUpdatedAt ?? null,
      JSON.stringify(source.raw),
      hashCanonicalJson(source.raw as JsonValue),
      seenAt,
      seenAt,
      seenAt,
      "active",
    );
}

function insertWorkItem(
  database: DatabaseSync,
  organizationId: string,
  workItem: WorkItem,
  sourceObjectId: string | undefined,
): void {
  database
    .prepare(
      `INSERT INTO work_items (
        id, organization_id, source_object_id, provider, source_type, external_id, title,
        url, status, work_type, created_at_source, updated_at_source, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workItem.id,
      organizationId,
      sourceObjectId ?? null,
      workItem.provider,
      workItem.sourceType,
      workItem.externalId,
      workItem.title,
      workItem.url ?? null,
      workItem.status,
      workItem.sourceType,
      workItem.createdAtSource ?? null,
      workItem.updatedAtSource ?? null,
      workItem.startedAt ?? null,
      workItem.completedAt ?? null,
    );
}

function insertActivityEvent(
  database: DatabaseSync,
  organizationId: string,
  event: ActivityEvent,
  sourceObjectId: string | undefined,
): void {
  database
    .prepare(
      `INSERT INTO activity_events (
        id, organization_id, source_object_id, provider, event_type, actor_person_id, work_item_id,
        repository_id, linear_team_id, linear_project_id, occurred_at, title, body, url, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      organizationId,
      sourceObjectId ?? null,
      event.provider,
      event.eventType,
      event.actorPersonId ?? null,
      event.workItemId ?? null,
      event.repositoryId ?? null,
      event.linearTeamId ?? null,
      event.linearProjectId ?? null,
      event.occurredAt,
      event.title,
      event.body ?? null,
      event.url ?? null,
      JSON.stringify(event.metadata ?? {}),
    );
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}
