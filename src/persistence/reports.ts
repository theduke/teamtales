import type { DatabaseSync } from "node:sqlite";

import type { ReportScopeType } from "../analysis/types.js";
import { jsonStringify, parseJsonObject, withTransaction } from "./sqlite.js";

export type ReportType = "weekly" | "monthly" | "quarterly" | "custom";
export type ReportStatus = "draft" | "completed" | "failed";
export type ReportInputType =
  | "analysis_report_context"
  | "analysis_metric"
  | "analysis_highlight"
  | "activity_event"
  | "work_item"
  | "source_object"
  | "previous_report";

export interface ReportRecord {
  id: string;
  organizationId: string;
  analysisReportContextId: string;
  reportType: ReportType;
  scopeType: ReportScopeType;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  status: ReportStatus;
  title: string;
  summary?: string | null;
  bodyMarkdown: string;
  structured: Record<string, unknown>;
  createdByUserId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReportInputRecord {
  id: string;
  reportId: string;
  inputType: ReportInputType;
  inputId: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface SaveCompleteReportResultInput {
  report: ReportRecord;
  inputs: readonly Omit<ReportInputRecord, "reportId">[];
}

export interface SavedReportResult {
  report: ReportRecord;
  inputs: ReportInputRecord[];
}

export function insertReport(database: DatabaseSync, report: ReportRecord): ReportRecord {
  database
    .prepare(
      `INSERT INTO reports (
        id, organization_id, analysis_report_context_id, report_type, scope_type, scope_id,
        period_start, period_end, status, title, summary, body_markdown, structured_json,
        created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      report.id,
      report.organizationId,
      report.analysisReportContextId,
      report.reportType,
      report.scopeType,
      report.scopeId,
      report.periodStart,
      report.periodEnd,
      report.status,
      report.title,
      report.summary ?? null,
      report.bodyMarkdown,
      jsonStringify(report.structured),
      report.createdByUserId ?? null,
    );

  return requireReport(database, report.id);
}

export function insertReportInput(database: DatabaseSync, input: ReportInputRecord): ReportInputRecord {
  database
    .prepare(
      `INSERT INTO report_inputs (id, report_id, input_type, input_id, metadata_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.reportId, input.inputType, input.inputId, jsonStringify(input.metadata ?? {}));

  return requireReportInput(database, input.id);
}

export function saveCompleteReportResult(
  database: DatabaseSync,
  input: SaveCompleteReportResultInput,
): SavedReportResult {
  return withTransaction(database, () => {
    const report = insertReport(database, input.report);
    const inputs = input.inputs.map((reportInput) =>
      insertReportInput(database, {
        ...reportInput,
        reportId: report.id,
      }),
    );

    return { report, inputs };
  });
}

export function getReport(database: DatabaseSync, id: string): ReportRecord | undefined {
  const row = database.prepare("SELECT * FROM reports WHERE id = ?").get(id);
  return row ? mapReport(row as Record<string, unknown>) : undefined;
}

export function requireReport(database: DatabaseSync, id: string): ReportRecord {
  const report = getReport(database, id);

  if (!report) {
    throw new Error(`Report not found: ${id}`);
  }

  return report;
}

export function listReportInputs(database: DatabaseSync, reportId: string): ReportInputRecord[] {
  return database
    .prepare("SELECT * FROM report_inputs WHERE report_id = ? ORDER BY id")
    .all(reportId)
    .map((row) => mapReportInput(row as Record<string, unknown>));
}

export function requireReportInput(database: DatabaseSync, id: string): ReportInputRecord {
  const row = database.prepare("SELECT * FROM report_inputs WHERE id = ?").get(id);

  if (!row) {
    throw new Error(`Report input not found: ${id}`);
  }

  return mapReportInput(row as Record<string, unknown>);
}

function mapReport(row: Record<string, unknown>): ReportRecord {
  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    analysisReportContextId: requiredString(row, "analysis_report_context_id"),
    reportType: requiredString(row, "report_type") as ReportType,
    scopeType: requiredString(row, "scope_type") as ReportScopeType,
    scopeId: requiredString(row, "scope_id"),
    periodStart: requiredString(row, "period_start"),
    periodEnd: requiredString(row, "period_end"),
    status: requiredString(row, "status") as ReportStatus,
    title: requiredString(row, "title"),
    summary: optionalString(row, "summary"),
    bodyMarkdown: requiredString(row, "body_markdown"),
    structured: parseJsonObject(requiredString(row, "structured_json")),
    createdByUserId: optionalString(row, "created_by_user_id"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapReportInput(row: Record<string, unknown>): ReportInputRecord {
  return {
    id: requiredString(row, "id"),
    reportId: requiredString(row, "report_id"),
    inputType: requiredString(row, "input_type") as ReportInputType,
    inputId: requiredString(row, "input_id"),
    metadata: parseJsonObject(requiredString(row, "metadata_json")),
    createdAt: requiredString(row, "created_at"),
  };
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
