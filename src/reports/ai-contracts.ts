import type { ReportContext } from "../analysis/types.js";

export type ReportType = "weekly" | "monthly" | "quarterly" | "custom";
export type AiRunType = ReportType | "comic_script" | "movie_script" | "fact_check" | "edit";
export type AiRunStatus = "queued" | "running" | "succeeded" | "failed";

export type ReportWriterInput = {
  context: ReportContext;
  tone: "concise" | "executive" | "cheerful" | "technical";
  audience: "team" | "manager" | "executive" | "customer";
  reportType: ReportType;
};

export type ReportWriterOutput = {
  title: string;
  executiveSummary: string;
  sections: ReportSection[];
  metricsSummary: string;
  risks: ReportRisk[];
  markdown: string;
};

export type ReportSection = {
  heading: string;
  body: string;
  sourceRefs: string[];
};

export type ReportRisk = {
  title: string;
  body: string;
  sourceRefs: string[];
};

export type FactCheckStatus = "pass" | "fail";
export type FactCheckSeverity = "low" | "medium" | "high";
export type FactCheckProblem =
  | "unsupported_claim"
  | "wrong_metric"
  | "wrong_date"
  | "unknown_person"
  | "unknown_project"
  | "unknown_repository"
  | "unknown_issue"
  | "unknown_pr"
  | "overconfident_causal_claim";

export type FactCheckInput = {
  context: ReportContext;
  draft: ReportWriterOutput;
};

export type FactCheckOutput = {
  status: FactCheckStatus;
  issues: FactCheckIssue[];
};

export type FactCheckIssue = {
  claim: string;
  problem: string;
  problemType: FactCheckProblem;
  severity: FactCheckSeverity;
  sourceRefs?: string[];
};

export type EditorInput = {
  context: ReportContext;
  draft: ReportWriterOutput;
  factCheck: FactCheckOutput;
  instruction: "improve_readability" | "shorten" | "adjust_tone" | "remove_unsupported_claims";
};

export type EditorOutput = ReportWriterOutput & {
  changes: string[];
};

export type AiRunRecord = {
  id: string;
  organizationId: string;
  runType: AiRunType;
  status: AiRunStatus;
  model: string;
  inputRefType: "analysis_report_context" | "report" | "report_artifact";
  inputRefId: string;
  promptVersion: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  createdAt: string;
};

export type AiRunStepRecord<Input = unknown, Output = unknown> = {
  id: string;
  aiRunId: string;
  stepName:
    | "write_report_outline"
    | "write_report_sections"
    | "fact_check_report"
    | "edit_report"
    | "generate_comic_script"
    | "generate_movie_script";
  status: AiRunStatus;
  input: Input;
  output?: Output;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
};

export function validateReportWriterOutput(output: ReportWriterOutput): string[] {
  const errors: string[] = [];

  if (output.title.trim() === "") errors.push("title is required");
  if (output.executiveSummary.trim() === "") errors.push("executiveSummary is required");
  if (output.metricsSummary.trim() === "") errors.push("metricsSummary is required");
  if (output.markdown.trim() === "") errors.push("markdown is required");

  output.sections.forEach((section, index) => {
    if (section.heading.trim() === "") errors.push(`sections[${index}].heading is required`);
    if (section.body.trim() === "") errors.push(`sections[${index}].body is required`);
    if (section.sourceRefs.length === 0) errors.push(`sections[${index}].sourceRefs must not be empty`);
  });

  return errors;
}

export function validateFactCheckOutput(output: FactCheckOutput): string[] {
  if (output.status === "pass" && output.issues.length > 0) {
    return ["passing fact checks must not include issues"];
  }

  if (output.status === "fail" && output.issues.length === 0) {
    return ["failing fact checks must include at least one issue"];
  }

  return [];
}
