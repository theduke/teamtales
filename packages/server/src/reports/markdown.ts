import type { Metric, ReportContext } from "../analysis/types.js";

export type WeeklyMarkdownReportOptions = {
  title?: string;
};

export function generateWeeklyMarkdownReport(context: ReportContext, options: WeeklyMarkdownReportOptions = {}): string {
  const title = options.title ?? `Weekly report: ${context.scope.name}`;
  const lines: string[] = [
    `# ${escapeMarkdownText(title)}`,
    "",
    `Organization: ${escapeMarkdownText(context.organization.name)}`,
    `Scope: ${escapeMarkdownText(context.scope.name)} (${context.scope.type})`,
    `Period: ${context.period.start} to ${context.period.end}`,
    "",
    "## Summary",
    "",
    summaryLine(context),
    "",
    "## Data freshness",
    "",
    ...freshnessLines(context),
    "",
    "## Metrics",
    "",
    ...metricLines(context.metrics),
    "",
    "## Observed highlights",
    "",
    ...highlightLines(context.highlights),
    "",
    "## Possible themes",
    "",
    ...themeLines(context),
    "",
    "## People",
    "",
    ...peopleLines(context.people),
    "",
    "## Work items",
    "",
    ...workItemLines(context.workItems),
    "",
    "## Possible risks",
    "",
    ...riskLines(context.risks),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function summaryLine(context: ReportContext): string {
  const parts = [
    pluralize(context.highlights.length, "observed highlight"),
    pluralize(context.people.length, "person with observed activity", "people with observed activity"),
    pluralize(context.workItems.length, "tracked work item"),
    pluralize(context.risks.length, "possible risk"),
  ];

  return `- This report is based on the provided report context: ${parts.join(", ")}.`;
}

function freshnessLines(context: ReportContext): string[] {
  const lines: string[] = [];

  if (context.freshness.github !== undefined) {
    lines.push(`- GitHub data observed through ${context.freshness.github}.`);
  }

  if (context.freshness.linear !== undefined) {
    lines.push(`- Linear data observed through ${context.freshness.linear}.`);
  }

  for (const warning of [...context.freshness.warnings].sort()) {
    lines.push(`- Warning: ${escapeMarkdownText(warning)}`);
  }

  return lines.length > 0 ? lines : ["- No freshness timestamps or warnings were provided."];
}

function metricLines(metrics: readonly Metric[]): string[] {
  if (metrics.length === 0) {
    return ["- No metrics were provided."];
  }

  return [...metrics].sort(compareMetrics).map((metric) => {
    const dimensions = formatDimensions(metric.dimensions);
    return `- ${escapeMarkdownText(metric.name)}: ${metric.value}${dimensions === "" ? "" : ` (${dimensions})`}`;
  });
}

function highlightLines(highlights: ReportContext["highlights"]): string[] {
  if (highlights.length === 0) {
    return ["- No highlights were provided."];
  }

  return [...highlights].sort(compareByTitleAndRefs).map((highlight) => {
    const suffix = formatRefs(highlight.sourceRefs);
    return `- ${escapeMarkdownText(highlight.title)}: ${escapeMarkdownText(highlight.reason)}${suffix}`;
  });
}

function themeLines(context: ReportContext): string[] {
  const completedCount = context.workItems.filter((item) => item.status === "completed" || item.status === "merged").length;
  const activeCount = context.workItems.filter((item) => item.status === "open" || item.status === "in_progress").length;
  const riskCount = context.risks.length;
  const lines: string[] = [];

  if (completedCount > 0) {
    lines.push(`- Completion may be a theme: ${pluralize(completedCount, "tracked work item")} is marked completed or merged.`);
  }

  if (activeCount > 0) {
    lines.push(`- Active work may be a theme: ${pluralize(activeCount, "tracked work item")} remains open or in progress.`);
  }

  if (riskCount > 0) {
    lines.push(`- Follow-up may be needed: ${pluralize(riskCount, "possible risk")} was included in the context.`);
  }

  return lines.length > 0 ? lines : ["- No possible themes were derived from the provided context."];
}

function peopleLines(people: ReportContext["people"]): string[] {
  if (people.length === 0) {
    return ["- No people activity summaries were provided."];
  }

  return [...people].sort((left, right) => left.displayName.localeCompare(right.displayName) || left.personId.localeCompare(right.personId)).map((person) => {
    const metrics = Object.entries(person.metrics)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}: ${value}`)
      .join(", ");
    const metricsText = metrics === "" ? "" : ` Metrics: ${escapeMarkdownText(metrics)}.`;
    return `- ${escapeMarkdownText(person.displayName)}: ${escapeMarkdownText(person.activitySummary)}${metricsText}${formatRefs(person.sourceRefs)}`;
  });
}

function workItemLines(workItems: ReportContext["workItems"]): string[] {
  if (workItems.length === 0) {
    return ["- No work items were provided."];
  }

  return [...workItems].sort(compareWorkItems).map((item) => {
    const title = item.url === "" ? escapeMarkdownText(item.title) : `[${escapeMarkdownText(item.title)}](${item.url})`;
    const facts = item.summaryFacts.map(escapeMarkdownText).join("; ");
    return `- ${title}: ${item.provider}, ${item.status}${facts === "" ? "" : `. Facts: ${facts}`}`;
  });
}

function riskLines(risks: ReportContext["risks"]): string[] {
  if (risks.length === 0) {
    return ["- No possible risks were provided."];
  }

  return [...risks].sort(compareByTitleAndRefs).map((risk) => {
    return `- Possible risk: ${escapeMarkdownText(risk.title)}. Context reason: ${escapeMarkdownText(risk.reason)}${formatRefs(risk.sourceRefs)}`;
  });
}

function compareMetrics(left: Metric, right: Metric): number {
  return left.name.localeCompare(right.name) || formatDimensions(left.dimensions).localeCompare(formatDimensions(right.dimensions));
}

function compareByTitleAndRefs<T extends { title: string; sourceRefs: readonly string[] }>(left: T, right: T): number {
  return left.title.localeCompare(right.title) || left.sourceRefs.join("\u0000").localeCompare(right.sourceRefs.join("\u0000"));
}

function compareWorkItems(left: ReportContext["workItems"][number], right: ReportContext["workItems"][number]): number {
  return left.provider.localeCompare(right.provider) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function formatDimensions(dimensions: Record<string, unknown> | undefined): string {
  if (dimensions === undefined) {
    return "";
  }

  return Object.entries(dimensions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

function formatRefs(sourceRefs: readonly string[]): string {
  if (sourceRefs.length === 0) {
    return "";
  }

  return ` Sources: ${[...sourceRefs].sort().map(escapeMarkdownText).join(", ")}.`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
