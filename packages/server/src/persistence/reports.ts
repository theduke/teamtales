import { and, asc, eq } from "drizzle-orm";

import type { ReportScopeType } from "../analysis/types.js";
import {
  activityEvents,
  analysisHighlights,
  analysisMetrics,
  analysisReportContexts,
  organizationMemberships,
  reportInputs,
  reports,
  sourceObjects,
  workItems,
} from "../db/schema.js";
import { jsonStringify, parseJsonObject, type PersistenceDatabase, withTransaction } from "./database.js";

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

export interface SavedReportResult { report: ReportRecord; inputs: ReportInputRecord[] }

export async function insertReport(database: PersistenceDatabase, report: ReportRecord): Promise<ReportRecord> {
  await requireReferencedAnalysisContext(database, report.organizationId, report.analysisReportContextId);
  if (report.createdByUserId) await requireUserMembership(database, report.organizationId, report.createdByUserId);

  await database.insert(reports).values({
    id: report.id,
    organizationId: report.organizationId,
    analysisReportContextId: report.analysisReportContextId,
    reportType: report.reportType,
    scopeType: report.scopeType,
    scopeId: report.scopeId,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    status: report.status,
    title: report.title,
    summary: report.summary ?? null,
    bodyMarkdown: report.bodyMarkdown,
    structuredJson: jsonStringify(report.structured),
    createdByUserId: report.createdByUserId ?? null,
  });
  return requireReport(database, report.id);
}

export async function insertReportInput(database: PersistenceDatabase, input: ReportInputRecord): Promise<ReportInputRecord> {
  const report = await requireReport(database, input.reportId);
  await requireReportInputReference(database, report.organizationId, input);
  await database.insert(reportInputs).values({
    id: input.id,
    reportId: input.reportId,
    inputType: input.inputType,
    inputId: input.inputId,
    metadataJson: jsonStringify(input.metadata ?? {}),
  });
  return requireReportInput(database, input.id);
}

export async function saveCompleteReportResult(
  database: PersistenceDatabase,
  input: SaveCompleteReportResultInput,
): Promise<SavedReportResult> {
  return withTransaction(database, async (transaction) => {
    const report = await insertReport(transaction, input.report);
    const inputs: ReportInputRecord[] = [];
    for (const reportInput of input.inputs) {
      inputs.push(await insertReportInput(transaction, { ...reportInput, reportId: report.id }));
    }
    return { report, inputs };
  });
}

export async function getReport(database: PersistenceDatabase, id: string): Promise<ReportRecord | undefined> {
  const [row] = await database.select().from(reports).where(eq(reports.id, id)).limit(1);
  return row ? mapReport(row) : undefined;
}

export async function getReportForOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  id: string,
): Promise<ReportRecord | undefined> {
  const [row] = await database.select().from(reports).where(and(
    eq(reports.organizationId, organizationId), eq(reports.id, id),
  )).limit(1);
  return row ? mapReport(row) : undefined;
}

export async function requireReport(database: PersistenceDatabase, id: string): Promise<ReportRecord> {
  const report = await getReport(database, id);
  if (!report) throw new Error(`Report not found: ${id}`);
  return report;
}

export async function listReportInputs(database: PersistenceDatabase, reportId: string): Promise<ReportInputRecord[]> {
  const rows = await database.select().from(reportInputs).where(eq(reportInputs.reportId, reportId))
    .orderBy(asc(reportInputs.id));
  return rows.map(mapReportInput);
}

export async function listReportInputsForOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  reportId: string,
): Promise<ReportInputRecord[]> {
  const rows = await database.select({ input: reportInputs }).from(reportInputs)
    .innerJoin(reports, eq(reports.id, reportInputs.reportId))
    .where(and(eq(reports.organizationId, organizationId), eq(reportInputs.reportId, reportId)))
    .orderBy(asc(reportInputs.id));
  return rows.map(({ input }) => mapReportInput(input));
}

export async function requireReportInput(database: PersistenceDatabase, id: string): Promise<ReportInputRecord> {
  const [row] = await database.select().from(reportInputs).where(eq(reportInputs.id, id)).limit(1);
  if (!row) throw new Error(`Report input not found: ${id}`);
  return mapReportInput(row);
}

async function requireReferencedAnalysisContext(
  database: PersistenceDatabase,
  organizationId: string,
  contextId: string,
): Promise<void> {
  const [row] = await database.select({ id: analysisReportContexts.id }).from(analysisReportContexts).where(and(
    eq(analysisReportContexts.organizationId, organizationId), eq(analysisReportContexts.id, contextId),
  )).limit(1);
  if (!row) throw new Error(`Analysis report context not found in organization ${organizationId}: ${contextId}`);
}

async function requireUserMembership(database: PersistenceDatabase, organizationId: string, userId: string): Promise<void> {
  const [row] = await database.select({ id: organizationMemberships.id }).from(organizationMemberships).where(and(
    eq(organizationMemberships.organizationId, organizationId),
    eq(organizationMemberships.userId, userId),
    eq(organizationMemberships.status, "active"),
  )).limit(1);
  if (!row) throw new Error(`Active organization membership not found: ${organizationId}/${userId}`);
}

async function requireReportInputReference(
  database: PersistenceDatabase,
  organizationId: string,
  input: Pick<ReportInputRecord, "inputType" | "inputId">,
): Promise<void> {
  let exists = false;
  switch (input.inputType) {
    case "analysis_report_context": exists = Boolean((await database.select({ id: analysisReportContexts.id }).from(analysisReportContexts).where(and(eq(analysisReportContexts.organizationId, organizationId), eq(analysisReportContexts.id, input.inputId))).limit(1))[0]); break;
    case "analysis_metric": exists = Boolean((await database.select({ id: analysisMetrics.id }).from(analysisMetrics).where(and(eq(analysisMetrics.organizationId, organizationId), eq(analysisMetrics.id, input.inputId))).limit(1))[0]); break;
    case "analysis_highlight": exists = Boolean((await database.select({ id: analysisHighlights.id }).from(analysisHighlights).where(and(eq(analysisHighlights.organizationId, organizationId), eq(analysisHighlights.id, input.inputId))).limit(1))[0]); break;
    case "activity_event": exists = Boolean((await database.select({ id: activityEvents.id }).from(activityEvents).where(and(eq(activityEvents.organizationId, organizationId), eq(activityEvents.id, input.inputId))).limit(1))[0]); break;
    case "work_item": exists = Boolean((await database.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.organizationId, organizationId), eq(workItems.id, input.inputId))).limit(1))[0]); break;
    case "source_object": exists = Boolean((await database.select({ id: sourceObjects.id }).from(sourceObjects).where(and(eq(sourceObjects.organizationId, organizationId), eq(sourceObjects.id, input.inputId))).limit(1))[0]); break;
    case "previous_report": exists = Boolean((await database.select({ id: reports.id }).from(reports).where(and(eq(reports.organizationId, organizationId), eq(reports.id, input.inputId))).limit(1))[0]); break;
    default: return;
  }
  if (!exists) throw new Error(`${input.inputType} input not found in organization ${organizationId}: ${input.inputId}`);
}

function mapReport(row: typeof reports.$inferSelect): ReportRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    analysisReportContextId: row.analysisReportContextId,
    reportType: row.reportType as ReportType,
    scopeType: row.scopeType as ReportScopeType,
    scopeId: row.scopeId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status as ReportStatus,
    title: row.title,
    summary: row.summary,
    bodyMarkdown: row.bodyMarkdown,
    structured: parseJsonObject(row.structuredJson),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapReportInput(row: typeof reportInputs.$inferSelect): ReportInputRecord {
  return {
    id: row.id,
    reportId: row.reportId,
    inputType: row.inputType as ReportInputType,
    inputId: row.inputId,
    metadata: parseJsonObject(row.metadataJson),
    createdAt: row.createdAt,
  };
}
