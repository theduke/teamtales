import type { DatabaseSync } from "node:sqlite";
import type { GenerateReportResponseDto, GenerateWeeklyReportRequestDto, JsonObject, ReportDto, ReportInputDto } from "@teamtales/common/api";
import type { Highlight, ReportContext } from "@teamtales/common/domain";

import { getAnalysisReportContext, saveCompleteAnalysisResult, saveCompleteReportResult } from "../persistence/index.js";
import { generateWeeklyMarkdownReport } from "../reports/index.js";
import { stableId } from "./ids.js";
import { resolveReportContext } from "./report-contexts.js";

export interface GenerateWeeklyReportServiceInput {
  analysisReportContextId?: string;
  context: ReportContext;
  title?: string;
  persist?: boolean;
  analysisRunIdSeed?: string;
  createdByUserId?: string;
}

export function generateWeeklyReportService(
  database: DatabaseSync,
  input: GenerateWeeklyReportServiceInput,
): GenerateReportResponseDto & { markdown: string; analysisReportContextId: string } {
  const markdown = generateWeeklyMarkdownReport(input.context, { title: input.title });
  const persist = input.persist ?? false;
  let analysisReportContextId = input.analysisReportContextId;

  if (persist && !analysisReportContextId) {
    const now = new Date().toISOString();
    const analysisRunId = stableId(
      "analysis_run",
      input.context.organization.id,
      input.context.scope.type,
      input.context.scope.id,
      input.context.period.start,
      input.context.period.end,
      input.analysisRunIdSeed ?? "service",
    );
    analysisReportContextId = stableId("report_context", analysisRunId);

    saveCompleteAnalysisResult(database, {
      run: {
        id: analysisRunId,
        organizationId: input.context.organization.id,
        scopeType: input.context.scope.type,
        scopeId: input.context.scope.id,
        periodStart: input.context.period.start,
        periodEnd: input.context.period.end,
        status: "completed",
        startedAt: now,
        finishedAt: now,
      },
      metrics: input.context.metrics.map((metric, index) => ({
        ...metric,
        id: stableId("metric", analysisRunId, String(index), metric.name, JSON.stringify(metric.dimensions ?? {})),
      })),
      highlights: input.context.highlights.flatMap((highlight, index) => {
        const workItemId = highlight.relatedWorkItems[0];
        if (workItemId === undefined) {
          return [];
        }

        return [{
          id: stableId(
            "highlight",
            analysisRunId,
            String(index),
            highlight.title,
            highlight.reason,
            JSON.stringify(highlight.sourceRefs),
            JSON.stringify(highlight.relatedPeople),
            JSON.stringify(highlight.relatedWorkItems),
          ),
          workItemId,
          highlightType: inferHighlightType(highlight),
          score: Math.max(1, 100 - index),
          title: highlight.title,
          reason: [highlight.reason],
          sourceRefs: highlight.sourceRefs,
          relatedPeople: highlight.relatedPeople,
          relatedWorkItems: highlight.relatedWorkItems,
        }];
      }),
      reportContext: {
        id: analysisReportContextId,
        context: input.context,
      },
    });
  }

  analysisReportContextId ??= stableId(
    "report_context",
    input.context.organization.id,
    input.context.scope.type,
    input.context.scope.id,
    input.context.period.start,
    input.context.period.end,
  );

  const reportId = stableId("report", analysisReportContextId, "weekly", input.context.period.start, input.context.period.end);
  const report: ReportDto = {
    id: reportId,
    organizationId: input.context.organization.id,
    analysisReportContextId,
    reportType: "weekly",
    scopeType: input.context.scope.type,
    scopeId: input.context.scope.id,
    periodStart: input.context.period.start,
    periodEnd: input.context.period.end,
    status: "completed",
    title: input.title ?? `Weekly report: ${input.context.scope.name}`,
    summary: undefined,
    bodyMarkdown: markdown,
    structured: { analysisReportContextId },
    createdByUserId: input.createdByUserId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const reportInput: ReportInputDto = {
    id: stableId("report_input", reportId, analysisReportContextId),
    reportId,
    inputType: "analysis_report_context",
    inputId: analysisReportContextId,
    metadata: { role: "primary" },
    createdAt: report.createdAt,
  };

  if (!persist) {
    return {
      report,
      inputs: [reportInput],
      markdown,
      analysisReportContextId,
    };
  }

  const saved = saveCompleteReportResult(database, {
    report: {
      id: report.id,
      organizationId: report.organizationId,
      analysisReportContextId: report.analysisReportContextId,
      reportType: "weekly",
      scopeType: report.scopeType,
      scopeId: report.scopeId,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      status: "completed",
      title: report.title,
      summary: null,
      bodyMarkdown: markdown,
      structured: { analysisReportContextId },
      createdByUserId: input.createdByUserId,
    },
    inputs: [
      {
        id: reportInput.id,
        inputType: "analysis_report_context",
        inputId: analysisReportContextId,
        metadata: { role: "primary" },
      },
    ],
  });

  return {
    report: {
      id: saved.report.id,
      organizationId: saved.report.organizationId,
      analysisReportContextId: saved.report.analysisReportContextId,
      reportType: saved.report.reportType,
      scopeType: saved.report.scopeType,
      scopeId: saved.report.scopeId,
      periodStart: saved.report.periodStart,
      periodEnd: saved.report.periodEnd,
      status: saved.report.status,
      title: saved.report.title,
      summary: saved.report.summary ?? undefined,
      bodyMarkdown: saved.report.bodyMarkdown,
      structured: saved.report.structured as JsonObject,
      createdByUserId: saved.report.createdByUserId ?? undefined,
      createdAt: saved.report.createdAt ?? report.createdAt,
      updatedAt: saved.report.updatedAt ?? report.updatedAt,
    },
    inputs: saved.inputs.map((item) => ({
      id: item.id,
      reportId: item.reportId,
      inputType: item.inputType,
      inputId: item.inputId,
      metadata: (item.metadata ?? {}) as JsonObject,
      createdAt: item.createdAt ?? report.createdAt,
    })),
    markdown,
    analysisReportContextId,
  };
}

function inferHighlightType(highlight: ReportContext["highlights"][number]): Highlight["highlightType"] {
  const text = `${highlight.title} ${highlight.reason}`.toLowerCase();
  if (text.includes("pull request") || text.includes("merged")) {
    return "merged_pr";
  }
  if (text.includes("discussion") || text.includes("comment") || text.includes("review")) {
    return "active_discussion";
  }
  if (text.includes("project")) {
    return "project_progress";
  }
  if (text.includes("block") || text.includes("risk")) {
    return "potential_blocker";
  }
  return "completed_work";
}

export function generateWeeklyReportFromStoredContextService(
  database: DatabaseSync,
  analysisReportContextId: string,
  options: { title?: string; persist?: boolean } = {},
): GenerateReportResponseDto & { markdown: string; analysisReportContextId: string } {
  const context = getAnalysisReportContext(database, analysisReportContextId);
  if (!context) {
    throw new Error(`Analysis report context not found: ${analysisReportContextId}`);
  }

  return generateWeeklyReportService(database, {
    analysisReportContextId,
    context: context.context,
    title: options.title,
    persist: options.persist ?? true,
  });
}

export function generateWeeklyReportFromRequestService(
  database: DatabaseSync,
  request: GenerateWeeklyReportRequestDto,
  options: { createdByUserId?: string } = {},
): GenerateReportResponseDto & { markdown: string; analysisReportContextId: string } {
  const resolved = resolveReportContext(database, {
    organizationId: request.organizationId,
    organizationName: request.organizationName,
    scopeType: request.scopeType,
    scopeId: request.scopeId,
    scopeName: request.scopeName,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
  });

  return generateWeeklyReportService(database, {
    analysisReportContextId: resolved.analysisReportContextId,
    context: resolved.context,
    title: request.title,
    persist: request.persist ?? true,
    analysisRunIdSeed: "api",
    createdByUserId: options.createdByUserId,
  });
}
