import { and, asc, desc, eq } from "drizzle-orm";

import type { Highlight, Metric, ReportContext, ReportScopeType } from "../analysis/types.js";
import {
  analysisHighlights,
  analysisMetrics,
  analysisReportContexts,
  analysisRuns,
} from "../db/schema.js";
import {
  jsonStringify,
  parseJsonObject,
  parseJsonValue,
  type PersistenceDatabase,
  withTransaction,
} from "./database.js";

export type AnalysisRunStatus = "running" | "completed" | "failed";

export interface AnalysisRunRecord {
  id: string;
  organizationId: string;
  scopeType: ReportScopeType;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  status: AnalysisRunStatus;
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
  createdAt?: string;
}

export interface AnalysisMetricRecord extends Metric {
  id: string;
  organizationId: string;
  analysisRunId: string;
  scopeType: ReportScopeType;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  createdAt?: string;
}

export interface AnalysisHighlightRecord extends Highlight {
  id: string;
  organizationId: string;
  analysisRunId: string;
  createdAt?: string;
}

export interface AnalysisReportContextRecord {
  id: string;
  organizationId: string;
  analysisRunId: string;
  scopeType: ReportScopeType;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  context: ReportContext;
  createdAt?: string;
}

export interface SaveCompleteAnalysisResultInput {
  run: AnalysisRunRecord;
  metrics: readonly (Metric & { id: string })[];
  highlights: readonly (Highlight & { id: string })[];
  reportContext: Omit<
    AnalysisReportContextRecord,
    "organizationId" | "analysisRunId" | "scopeType" | "scopeId" | "periodStart" | "periodEnd"
  >;
}

export interface SavedAnalysisResult {
  run: AnalysisRunRecord;
  metrics: AnalysisMetricRecord[];
  highlights: AnalysisHighlightRecord[];
  reportContext: AnalysisReportContextRecord;
}

export async function insertAnalysisRun(
  database: PersistenceDatabase,
  run: AnalysisRunRecord,
): Promise<AnalysisRunRecord> {
  await database.insert(analysisRuns).values({
    id: run.id,
    organizationId: run.organizationId,
    scopeType: run.scopeType,
    scopeId: run.scopeId,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    error: run.error ?? null,
  });
  return requireAnalysisRun(database, run.id);
}

export async function insertAnalysisMetric(
  database: PersistenceDatabase,
  metric: AnalysisMetricRecord,
): Promise<AnalysisMetricRecord> {
  await database.insert(analysisMetrics).values({
    id: metric.id,
    organizationId: metric.organizationId,
    analysisRunId: metric.analysisRunId,
    scopeType: metric.scopeType,
    scopeId: metric.scopeId,
    periodStart: metric.periodStart,
    periodEnd: metric.periodEnd,
    metricName: metric.name,
    metricValue: metric.value,
    dimensionsJson: jsonStringify(metric.dimensions ?? {}),
  });
  return requireAnalysisMetric(database, metric.id);
}

export async function insertAnalysisHighlight(
  database: PersistenceDatabase,
  highlight: AnalysisHighlightRecord,
): Promise<AnalysisHighlightRecord> {
  await database.insert(analysisHighlights).values({
    id: highlight.id,
    organizationId: highlight.organizationId,
    analysisRunId: highlight.analysisRunId,
    workItemId: highlight.workItemId,
    highlightType: highlight.highlightType,
    score: highlight.score,
    title: highlight.title,
    reason: jsonStringify(highlight.reason),
    sourceRefsJson: jsonStringify(highlight.sourceRefs),
  });
  return requireAnalysisHighlight(database, highlight.id);
}

export async function insertAnalysisReportContext(
  database: PersistenceDatabase,
  context: AnalysisReportContextRecord,
): Promise<AnalysisReportContextRecord> {
  await database.insert(analysisReportContexts).values({
    id: context.id,
    organizationId: context.organizationId,
    analysisRunId: context.analysisRunId,
    scopeType: context.scopeType,
    scopeId: context.scopeId,
    periodStart: context.periodStart,
    periodEnd: context.periodEnd,
    contextJson: jsonStringify(context.context),
  });
  return requireAnalysisReportContext(database, context.id);
}

export async function saveCompleteAnalysisResult(
  database: PersistenceDatabase,
  input: SaveCompleteAnalysisResultInput,
): Promise<SavedAnalysisResult> {
  return withTransaction(database, async (transaction) => {
    const run = await insertAnalysisRun(transaction, input.run);
    const metrics: AnalysisMetricRecord[] = [];
    for (const metric of input.metrics) {
      metrics.push(
        await insertAnalysisMetric(transaction, {
          ...metric,
          organizationId: run.organizationId,
          analysisRunId: run.id,
          scopeType: run.scopeType,
          scopeId: run.scopeId,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
        }),
      );
    }
    const highlights: AnalysisHighlightRecord[] = [];
    for (const highlight of input.highlights) {
      highlights.push(
        await insertAnalysisHighlight(transaction, {
          ...highlight,
          organizationId: run.organizationId,
          analysisRunId: run.id,
        }),
      );
    }
    const reportContext = await insertAnalysisReportContext(transaction, {
      ...input.reportContext,
      organizationId: run.organizationId,
      analysisRunId: run.id,
      scopeType: run.scopeType,
      scopeId: run.scopeId,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
    });
    return { run, metrics, highlights, reportContext };
  });
}

export async function getAnalysisRun(
  database: PersistenceDatabase,
  id: string,
): Promise<AnalysisRunRecord | undefined> {
  const [row] = await database.select().from(analysisRuns).where(eq(analysisRuns.id, id)).limit(1);
  return row ? mapAnalysisRun(row) : undefined;
}

export async function getAnalysisRunForOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  id: string,
): Promise<AnalysisRunRecord | undefined> {
  const [row] = await database
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.organizationId, organizationId), eq(analysisRuns.id, id)))
    .limit(1);
  return row ? mapAnalysisRun(row) : undefined;
}

export async function requireAnalysisRun(
  database: PersistenceDatabase,
  id: string,
): Promise<AnalysisRunRecord> {
  const run = await getAnalysisRun(database, id);
  if (!run) throw new Error(`Analysis run not found: ${id}`);
  return run;
}

export async function listAnalysisMetrics(
  database: PersistenceDatabase,
  analysisRunId: string,
): Promise<AnalysisMetricRecord[]> {
  const rows = await database
    .select()
    .from(analysisMetrics)
    .where(eq(analysisMetrics.analysisRunId, analysisRunId))
    .orderBy(asc(analysisMetrics.id));
  return rows.map(mapAnalysisMetric);
}

export async function listAnalysisMetricsForOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  analysisRunId: string,
): Promise<AnalysisMetricRecord[]> {
  const rows = await database
    .select()
    .from(analysisMetrics)
    .where(
      and(
        eq(analysisMetrics.organizationId, organizationId),
        eq(analysisMetrics.analysisRunId, analysisRunId),
      ),
    )
    .orderBy(asc(analysisMetrics.id));
  return rows.map(mapAnalysisMetric);
}

export async function requireAnalysisMetric(
  database: PersistenceDatabase,
  id: string,
): Promise<AnalysisMetricRecord> {
  const [row] = await database
    .select()
    .from(analysisMetrics)
    .where(eq(analysisMetrics.id, id))
    .limit(1);
  if (!row) throw new Error(`Analysis metric not found: ${id}`);
  return mapAnalysisMetric(row);
}

export async function getAnalysisMetricForOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  id: string,
): Promise<AnalysisMetricRecord | undefined> {
  const [row] = await database
    .select()
    .from(analysisMetrics)
    .where(and(eq(analysisMetrics.organizationId, organizationId), eq(analysisMetrics.id, id)))
    .limit(1);
  return row ? mapAnalysisMetric(row) : undefined;
}

export async function listAnalysisHighlights(
  database: PersistenceDatabase,
  analysisRunId: string,
): Promise<AnalysisHighlightRecord[]> {
  const rows = await database
    .select()
    .from(analysisHighlights)
    .where(eq(analysisHighlights.analysisRunId, analysisRunId))
    .orderBy(desc(analysisHighlights.score), asc(analysisHighlights.id));
  return rows.map(mapAnalysisHighlight);
}

export async function listAnalysisHighlightsForOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  analysisRunId: string,
): Promise<AnalysisHighlightRecord[]> {
  const rows = await database
    .select()
    .from(analysisHighlights)
    .where(
      and(
        eq(analysisHighlights.organizationId, organizationId),
        eq(analysisHighlights.analysisRunId, analysisRunId),
      ),
    )
    .orderBy(desc(analysisHighlights.score), asc(analysisHighlights.id));
  return rows.map(mapAnalysisHighlight);
}

export async function requireAnalysisHighlight(
  database: PersistenceDatabase,
  id: string,
): Promise<AnalysisHighlightRecord> {
  const [row] = await database
    .select()
    .from(analysisHighlights)
    .where(eq(analysisHighlights.id, id))
    .limit(1);
  if (!row) throw new Error(`Analysis highlight not found: ${id}`);
  return mapAnalysisHighlight(row);
}

export async function getAnalysisHighlightForOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  id: string,
): Promise<AnalysisHighlightRecord | undefined> {
  const [row] = await database
    .select()
    .from(analysisHighlights)
    .where(
      and(eq(analysisHighlights.organizationId, organizationId), eq(analysisHighlights.id, id)),
    )
    .limit(1);
  return row ? mapAnalysisHighlight(row) : undefined;
}

export async function getAnalysisReportContext(
  database: PersistenceDatabase,
  id: string,
): Promise<AnalysisReportContextRecord | undefined> {
  const [row] = await database
    .select()
    .from(analysisReportContexts)
    .where(eq(analysisReportContexts.id, id))
    .limit(1);
  return row ? mapAnalysisReportContext(row) : undefined;
}

export async function getAnalysisReportContextForOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  id: string,
): Promise<AnalysisReportContextRecord | undefined> {
  const [row] = await database
    .select()
    .from(analysisReportContexts)
    .where(
      and(
        eq(analysisReportContexts.organizationId, organizationId),
        eq(analysisReportContexts.id, id),
      ),
    )
    .limit(1);
  return row ? mapAnalysisReportContext(row) : undefined;
}

export async function requireAnalysisReportContext(
  database: PersistenceDatabase,
  id: string,
): Promise<AnalysisReportContextRecord> {
  const context = await getAnalysisReportContext(database, id);
  if (!context) throw new Error(`Analysis report context not found: ${id}`);
  return context;
}

function mapAnalysisRun(row: typeof analysisRuns.$inferSelect): AnalysisRunRecord {
  return {
    ...row,
    scopeType: row.scopeType as ReportScopeType,
    status: row.status as AnalysisRunStatus,
  };
}

function mapAnalysisMetric(row: typeof analysisMetrics.$inferSelect): AnalysisMetricRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    analysisRunId: row.analysisRunId,
    scopeType: row.scopeType as ReportScopeType,
    scopeId: row.scopeId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    name: row.metricName,
    value: row.metricValue,
    dimensions: parseJsonObject(row.dimensionsJson),
    createdAt: row.createdAt,
  };
}

function mapAnalysisHighlight(
  row: typeof analysisHighlights.$inferSelect,
): AnalysisHighlightRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    analysisRunId: row.analysisRunId,
    workItemId: row.workItemId ?? "",
    highlightType: row.highlightType as Highlight["highlightType"],
    score: row.score,
    title: row.title,
    reason: parseStringArray(row.reason),
    sourceRefs: parseStringArray(row.sourceRefsJson),
    relatedPeople: [],
    relatedWorkItems: [],
    createdAt: row.createdAt,
  };
}

function mapAnalysisReportContext(
  row: typeof analysisReportContexts.$inferSelect,
): AnalysisReportContextRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    analysisRunId: row.analysisRunId,
    scopeType: row.scopeType as ReportScopeType,
    scopeId: row.scopeId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    context: parseJsonValue(row.contextJson) as ReportContext,
    createdAt: row.createdAt,
  };
}

function parseStringArray(json: string): string[] {
  const value = parseJsonValue(json);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected JSON string array");
  }
  return value;
}
