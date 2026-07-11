import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { count, eq } from "drizzle-orm";

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
import type { AppDatabase } from "../../src/db/index.js";
import { activityEvents, integrations, organizationMemberships, organizations, people, sourceObjects, syncScopes, users, workItems } from "../../src/db/schema.js";
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
import { mysqlTestOptions, openTestDatabase } from "../helpers/mysql.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/e2e/source-to-report.json");

describe("source-to-report fixture flow", mysqlTestOptions, () => {
  it("normalizes GitHub and Linear source objects into a deterministic persisted markdown report", async () => {
    const fixture = loadFixture();
    const local = await openTestDatabase();

    try {
      await seedTenantAndIntegrationRows(local.db, fixture);
      await insertPeople(local.db, fixture.organization.id, fixture.people);

      const normalized = normalizeFixtureSourceObjects(fixture.sourceObjects);
      for (const source of fixture.sourceObjects) {
        await insertSourceObject(local.db, fixture.organization.id, source);
      }
      for (const workItem of normalized.workItems) {
        await insertWorkItem(local.db, fixture.organization.id, workItem, normalized.sourceObjectByWorkItem.get(workItem.id));
      }
      for (const event of normalized.events) {
        await insertActivityEvent(local.db, fixture.organization.id, event, normalized.sourceObjectByEvent.get(event.id));
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

      const analysis = await saveCompleteAnalysisResult(local.db, {
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

      const report = await saveCompleteReportResult(local.db, {
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

      assert.equal((await getAnalysisRun(local.db, "analysis_run_fixture"))?.status, "completed");
      assert.deepEqual((await getAnalysisReportContext(local.db, "analysis_report_context_fixture"))?.context, reportContext);
      assert.equal((await listAnalysisMetrics(local.db, "analysis_run_fixture")).length, metrics.length);
      assert.deepEqual(
        (await listAnalysisMetrics(local.db, "analysis_run_fixture")).map((metric) => [metric.name, metric.value]),
        metrics.map((metric) => [metric.name, metric.value]),
      );
      assert.equal((await listAnalysisHighlights(local.db, "analysis_run_fixture")).length, highlights.length);
      assert.equal((await getReport(local.db, "report_fixture"))?.bodyMarkdown, markdown);
      assert.equal((await listReportInputs(local.db, report.report.id)).length, report.inputs.length);
      assert.equal(await countRows(local.db, sourceObjects, fixture.organization.id), fixture.sourceObjects.length);
      assert.equal(await countRows(local.db, workItems, fixture.organization.id), normalized.workItems.length);
      assert.equal(await countRows(local.db, activityEvents, fixture.organization.id), normalized.events.length);
    } finally {
      await local.db.delete(organizations).where(eq(organizations.id, fixture.organization.id));
      await local.db.delete(users).where(eq(users.id, "user_fixture_owner"));
      await local.close();
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

async function seedTenantAndIntegrationRows(database: AppDatabase, fixture: Fixture): Promise<void> {
  const ownerUserId = "user_fixture_owner";
  await database.insert(organizations).values({ id: fixture.organization.id, name: fixture.organization.name, slug: "fixtureco" });
  await database.insert(users).values({ id: ownerUserId, displayName: "Fixture Owner", primaryEmail: "owner@fixtureco.example" });
  await database.insert(organizationMemberships).values({ id: "membership_fixture_owner", organizationId: fixture.organization.id, userId: ownerUserId, role: "owner", status: "active" });
  await database.insert(integrations).values([
    { id: "integration_github", organizationId: fixture.organization.id, provider: "github", authType: "personal_access_token", status: "active", displayName: "Fixture GitHub" },
    { id: "integration_linear", organizationId: fixture.organization.id, provider: "linear", authType: "personal_access_token", status: "active", displayName: "Fixture Linear" },
  ]);
  await database.insert(syncScopes).values([
    { id: "scope_github_widgets", organizationId: fixture.organization.id, integrationId: "integration_github", provider: "github", scopeType: "github.repository", externalId: "fixtureco/widgets", externalName: "fixtureco/widgets", configJson: "{}", lastSuccessAt: fixture.freshness.github },
    { id: "scope_linear_workspace", organizationId: fixture.organization.id, integrationId: "integration_linear", provider: "linear", scopeType: "linear.workspace", externalId: "fixture-linear", externalName: "Fixture Linear", configJson: "{}", lastSuccessAt: fixture.freshness.linear },
  ]);
}

async function insertPeople(database: AppDatabase, organizationId: string, values: readonly Person[]): Promise<void> {
  await database.insert(people).values(values.map(person => ({ id: person.id, organizationId, displayName: person.displayName })));
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

async function insertSourceObject(database: AppDatabase, organizationId: string, source: FixtureSourceObject): Promise<void> {
  const seenAt = "2026-06-29T08:00:00.000Z";
  await database.insert(sourceObjects).values({ id: source.id, organizationId, integrationId: source.integrationId, syncScopeId: source.syncScopeId, provider: source.provider, objectType: source.objectType, externalId: source.externalId, externalUrl: source.externalUrl, externalCreatedAt: source.externalCreatedAt, externalUpdatedAt: source.externalUpdatedAt, rawJson: JSON.stringify(source.raw), contentHash: hashCanonicalJson(source.raw as JsonValue), firstSeenAt: seenAt, lastSeenAt: seenAt, lastChangedAt: seenAt, sourceState: "active" });
}

async function insertWorkItem(
  database: AppDatabase,
  organizationId: string,
  workItem: WorkItem,
  sourceObjectId: string | undefined,
): Promise<void> {
  await database.insert(workItems).values({ id: workItem.id, organizationId, sourceObjectId, provider: workItem.provider, sourceType: workItem.sourceType, externalId: workItem.externalId, title: workItem.title, url: workItem.url, status: workItem.status, workType: workItem.sourceType, createdAtSource: workItem.createdAtSource, updatedAtSource: workItem.updatedAtSource, startedAt: workItem.startedAt, completedAt: workItem.completedAt });
}

async function insertActivityEvent(
  database: AppDatabase,
  organizationId: string,
  event: ActivityEvent,
  sourceObjectId: string | undefined,
): Promise<void> {
  await database.insert(activityEvents).values({ id: event.id, organizationId, sourceObjectId, provider: event.provider, eventType: event.eventType, actorPersonId: event.actorPersonId, workItemId: event.workItemId, repositoryId: event.repositoryId, linearTeamId: event.linearTeamId, linearProjectId: event.linearProjectId, occurredAt: event.occurredAt, title: event.title, body: event.body, url: event.url, metadataJson: JSON.stringify(event.metadata ?? {}) });
}

async function countRows(database: AppDatabase, table: typeof sourceObjects | typeof workItems | typeof activityEvents, organizationId: string): Promise<number> {
  const [row] = await database.select({ value: count() }).from(table).where(eq(table.organizationId, organizationId));
  return row?.value ?? 0;
}
