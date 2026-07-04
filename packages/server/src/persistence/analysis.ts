import type { DatabaseSync } from "node:sqlite";

import type { Highlight, Metric, ReportContext, ReportScopeType } from "../analysis/types.js";
import { jsonStringify, parseJsonObject, parseJsonValue, withTransaction } from "./sqlite.js";

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
  reportContext: Omit<AnalysisReportContextRecord, "organizationId" | "analysisRunId" | "scopeType" | "scopeId" | "periodStart" | "periodEnd">;
}

export interface SavedAnalysisResult {
  run: AnalysisRunRecord;
  metrics: AnalysisMetricRecord[];
  highlights: AnalysisHighlightRecord[];
  reportContext: AnalysisReportContextRecord;
}

export function insertAnalysisRun(database: DatabaseSync, run: AnalysisRunRecord): AnalysisRunRecord {
  database
    .prepare(
      `INSERT INTO analysis_runs (
        id, organization_id, scope_type, scope_id, period_start, period_end,
        status, started_at, finished_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.id,
      run.organizationId,
      run.scopeType,
      run.scopeId,
      run.periodStart,
      run.periodEnd,
      run.status,
      run.startedAt,
      run.finishedAt ?? null,
      run.error ?? null,
    );

  return requireAnalysisRun(database, run.id);
}

export function insertAnalysisMetric(database: DatabaseSync, metric: AnalysisMetricRecord): AnalysisMetricRecord {
  database
    .prepare(
      `INSERT INTO analysis_metrics (
        id, organization_id, analysis_run_id, scope_type, scope_id, period_start, period_end,
        metric_name, metric_value, dimensions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      metric.id,
      metric.organizationId,
      metric.analysisRunId,
      metric.scopeType,
      metric.scopeId,
      metric.periodStart,
      metric.periodEnd,
      metric.name,
      metric.value,
      jsonStringify(metric.dimensions ?? {}),
    );

  return requireAnalysisMetric(database, metric.id);
}

export function insertAnalysisHighlight(
  database: DatabaseSync,
  highlight: AnalysisHighlightRecord,
): AnalysisHighlightRecord {
  database
    .prepare(
      `INSERT INTO analysis_highlights (
        id, organization_id, analysis_run_id, work_item_id, highlight_type, score,
        title, reason, source_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      highlight.id,
      highlight.organizationId,
      highlight.analysisRunId,
      highlight.workItemId,
      highlight.highlightType,
      highlight.score,
      highlight.title,
      jsonStringify(highlight.reason),
      jsonStringify(highlight.sourceRefs),
    );

  return requireAnalysisHighlight(database, highlight.id);
}

export function insertAnalysisReportContext(
  database: DatabaseSync,
  context: AnalysisReportContextRecord,
): AnalysisReportContextRecord {
  database
    .prepare(
      `INSERT INTO analysis_report_contexts (
        id, organization_id, analysis_run_id, scope_type, scope_id,
        period_start, period_end, context_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      context.id,
      context.organizationId,
      context.analysisRunId,
      context.scopeType,
      context.scopeId,
      context.periodStart,
      context.periodEnd,
      jsonStringify(context.context),
    );

  return requireAnalysisReportContext(database, context.id);
}

export function saveCompleteAnalysisResult(
  database: DatabaseSync,
  input: SaveCompleteAnalysisResultInput,
): SavedAnalysisResult {
  return withTransaction(database, () => {
    const run = insertAnalysisRun(database, input.run);
    const metrics = input.metrics.map((metric) =>
      insertAnalysisMetric(database, {
        ...metric,
        organizationId: run.organizationId,
        analysisRunId: run.id,
        scopeType: run.scopeType,
        scopeId: run.scopeId,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
      }),
    );
    const highlights = input.highlights.map((highlight) =>
      insertAnalysisHighlight(database, {
        ...highlight,
        organizationId: run.organizationId,
        analysisRunId: run.id,
      }),
    );
    const reportContext = insertAnalysisReportContext(database, {
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

export function getAnalysisRun(database: DatabaseSync, id: string): AnalysisRunRecord | undefined {
  const row = database.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(id);
  return row ? mapAnalysisRun(row as Record<string, unknown>) : undefined;
}

export function getAnalysisRunForOrganization(
  database: DatabaseSync,
  organizationId: string,
  id: string,
): AnalysisRunRecord | undefined {
  const row = database.prepare("SELECT * FROM analysis_runs WHERE organization_id = ? AND id = ?").get(organizationId, id);
  return row ? mapAnalysisRun(row as Record<string, unknown>) : undefined;
}

export function requireAnalysisRun(database: DatabaseSync, id: string): AnalysisRunRecord {
  const run = getAnalysisRun(database, id);

  if (!run) {
    throw new Error(`Analysis run not found: ${id}`);
  }

  return run;
}

export function listAnalysisMetrics(database: DatabaseSync, analysisRunId: string): AnalysisMetricRecord[] {
  return database
    .prepare("SELECT * FROM analysis_metrics WHERE analysis_run_id = ? ORDER BY id")
    .all(analysisRunId)
    .map((row) => mapAnalysisMetric(row as Record<string, unknown>));
}

export function listAnalysisMetricsForOrganization(
  database: DatabaseSync,
  organizationId: string,
  analysisRunId: string,
): AnalysisMetricRecord[] {
  return database
    .prepare("SELECT * FROM analysis_metrics WHERE organization_id = ? AND analysis_run_id = ? ORDER BY id")
    .all(organizationId, analysisRunId)
    .map((row) => mapAnalysisMetric(row as Record<string, unknown>));
}

export function requireAnalysisMetric(database: DatabaseSync, id: string): AnalysisMetricRecord {
  const row = database.prepare("SELECT * FROM analysis_metrics WHERE id = ?").get(id);

  if (!row) {
    throw new Error(`Analysis metric not found: ${id}`);
  }

  return mapAnalysisMetric(row as Record<string, unknown>);
}

export function getAnalysisMetricForOrganization(
  database: DatabaseSync,
  organizationId: string,
  id: string,
): AnalysisMetricRecord | undefined {
  const row = database.prepare("SELECT * FROM analysis_metrics WHERE organization_id = ? AND id = ?").get(organizationId, id);
  return row ? mapAnalysisMetric(row as Record<string, unknown>) : undefined;
}

export function listAnalysisHighlights(database: DatabaseSync, analysisRunId: string): AnalysisHighlightRecord[] {
  return database
    .prepare("SELECT * FROM analysis_highlights WHERE analysis_run_id = ? ORDER BY score DESC, id")
    .all(analysisRunId)
    .map((row) => mapAnalysisHighlight(row as Record<string, unknown>));
}

export function listAnalysisHighlightsForOrganization(
  database: DatabaseSync,
  organizationId: string,
  analysisRunId: string,
): AnalysisHighlightRecord[] {
  return database
    .prepare("SELECT * FROM analysis_highlights WHERE organization_id = ? AND analysis_run_id = ? ORDER BY score DESC, id")
    .all(organizationId, analysisRunId)
    .map((row) => mapAnalysisHighlight(row as Record<string, unknown>));
}

export function requireAnalysisHighlight(database: DatabaseSync, id: string): AnalysisHighlightRecord {
  const row = database.prepare("SELECT * FROM analysis_highlights WHERE id = ?").get(id);

  if (!row) {
    throw new Error(`Analysis highlight not found: ${id}`);
  }

  return mapAnalysisHighlight(row as Record<string, unknown>);
}

export function getAnalysisHighlightForOrganization(
  database: DatabaseSync,
  organizationId: string,
  id: string,
): AnalysisHighlightRecord | undefined {
  const row = database
    .prepare("SELECT * FROM analysis_highlights WHERE organization_id = ? AND id = ?")
    .get(organizationId, id);
  return row ? mapAnalysisHighlight(row as Record<string, unknown>) : undefined;
}

export function getAnalysisReportContext(
  database: DatabaseSync,
  id: string,
): AnalysisReportContextRecord | undefined {
  const row = database.prepare("SELECT * FROM analysis_report_contexts WHERE id = ?").get(id);
  return row ? mapAnalysisReportContext(row as Record<string, unknown>) : undefined;
}

export function getAnalysisReportContextForOrganization(
  database: DatabaseSync,
  organizationId: string,
  id: string,
): AnalysisReportContextRecord | undefined {
  const row = database
    .prepare("SELECT * FROM analysis_report_contexts WHERE organization_id = ? AND id = ?")
    .get(organizationId, id);
  return row ? mapAnalysisReportContext(row as Record<string, unknown>) : undefined;
}

export function requireAnalysisReportContext(database: DatabaseSync, id: string): AnalysisReportContextRecord {
  const context = getAnalysisReportContext(database, id);

  if (!context) {
    throw new Error(`Analysis report context not found: ${id}`);
  }

  return context;
}

function mapAnalysisRun(row: Record<string, unknown>): AnalysisRunRecord {
  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    scopeType: requiredString(row, "scope_type") as ReportScopeType,
    scopeId: requiredString(row, "scope_id"),
    periodStart: requiredString(row, "period_start"),
    periodEnd: requiredString(row, "period_end"),
    status: requiredString(row, "status") as AnalysisRunStatus,
    startedAt: requiredString(row, "started_at"),
    finishedAt: optionalString(row, "finished_at"),
    error: optionalString(row, "error"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapAnalysisMetric(row: Record<string, unknown>): AnalysisMetricRecord {
  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    analysisRunId: requiredString(row, "analysis_run_id"),
    scopeType: requiredString(row, "scope_type") as ReportScopeType,
    scopeId: requiredString(row, "scope_id"),
    periodStart: requiredString(row, "period_start"),
    periodEnd: requiredString(row, "period_end"),
    name: requiredString(row, "metric_name"),
    value: requiredNumber(row, "metric_value"),
    dimensions: parseJsonObject(requiredString(row, "dimensions_json")),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapAnalysisHighlight(row: Record<string, unknown>): AnalysisHighlightRecord {
  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    analysisRunId: requiredString(row, "analysis_run_id"),
    workItemId: optionalString(row, "work_item_id") ?? "",
    highlightType: requiredString(row, "highlight_type") as Highlight["highlightType"],
    score: requiredNumber(row, "score"),
    title: requiredString(row, "title"),
    reason: parseStringArray(requiredString(row, "reason")),
    sourceRefs: parseStringArray(requiredString(row, "source_refs_json")),
    relatedPeople: [],
    relatedWorkItems: [],
    createdAt: requiredString(row, "created_at"),
  };
}

function mapAnalysisReportContext(row: Record<string, unknown>): AnalysisReportContextRecord {
  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    analysisRunId: requiredString(row, "analysis_run_id"),
    scopeType: requiredString(row, "scope_type") as ReportScopeType,
    scopeId: requiredString(row, "scope_id"),
    periodStart: requiredString(row, "period_start"),
    periodEnd: requiredString(row, "period_end"),
    context: parseJsonValue(requiredString(row, "context_json")) as ReportContext,
    createdAt: requiredString(row, "created_at"),
  };
}

function parseStringArray(json: string): string[] {
  const value = parseJsonValue(json);

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected JSON string array");
  }

  return value;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];

  if (typeof value !== "string") {
    throw new Error(`Expected string column: ${key}`);
  }

  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected nullable string column: ${key}`);
  }

  return value;
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];

  if (typeof value !== "number") {
    throw new Error(`Expected number column: ${key}`);
  }

  return value;
}
