import type {
  AnalysisInput,
  Freshness,
  Highlight,
  ReportContext,
  Risk,
  WorkItem,
} from "./types.js";
import { computeActivityMetrics, computePersonMetrics, eventsInPeriod } from "./metrics.js";
import { detectRisks, scoreHighlights } from "./highlights.js";

export function buildReportContext(input: AnalysisInput): ReportContext {
  const events = eventsInPeriod(input.events, input.period.start, input.period.end);
  const metrics = computeActivityMetrics(events);
  const highlights = scoreHighlights(input.workItems, events, {
    periodStart: input.period.start,
    periodEnd: input.period.end,
    ...(input.manuallyPinnedWorkItemIds === undefined
      ? {}
      : { manuallyPinnedWorkItemIds: input.manuallyPinnedWorkItemIds }),
  });
  const riskHighlights = detectRisks(input.workItems, events, input.period.end);
  const personMetrics = computePersonMetrics(events);

  return {
    organization: input.organization,
    scope: input.scope,
    period: input.period,
    freshness: normalizeFreshness(input.freshness),
    metrics,
    highlights: highlights.map(toReportHighlight),
    people: input.people
      .map((person) => {
        const sourceRefs = events
          .filter((event) => event.actorPersonId === person.id)
          .map((event) => event.sourceRef ?? `activity_event:${event.id}`)
          .sort();

        return {
          personId: person.id,
          displayName: person.displayName,
          activitySummary: summarizePersonActivity(
            person.displayName,
            personMetrics.get(person.id) ?? {},
          ),
          metrics: personMetrics.get(person.id) ?? {},
          sourceRefs,
        };
      })
      .filter((person) => Object.keys(person.metrics).length > 0),
    workItems: input.workItems.map((workItem) => toReportWorkItem(workItem, events)),
    risks: riskHighlights.map(toRisk),
  };
}

function normalizeFreshness(freshness: Partial<Freshness> | undefined): Freshness {
  return {
    ...(freshness?.github === undefined ? {} : { github: freshness.github }),
    ...(freshness?.linear === undefined ? {} : { linear: freshness.linear }),
    warnings: freshness?.warnings ?? [],
  };
}

function toReportHighlight(highlight: Highlight): ReportContext["highlights"][number] {
  return {
    title: highlight.title,
    reason: highlight.reason.join("; "),
    sourceRefs: highlight.sourceRefs,
    relatedPeople: highlight.relatedPeople,
    relatedWorkItems: highlight.relatedWorkItems,
  };
}

function toRisk(highlight: Highlight): Risk {
  return {
    title: highlight.title,
    reason: highlight.reason.join("; "),
    sourceRefs: highlight.sourceRefs,
  };
}

function toReportWorkItem(
  workItem: WorkItem,
  events: readonly { workItemId?: string; title: string; sourceRef?: string; id: string }[],
): ReportContext["workItems"][number] {
  const relatedEvents = events.filter((event) => event.workItemId === workItem.id);
  const summaryFacts = [
    `${workItem.provider} ${workItem.sourceType} is ${workItem.status}`,
    ...relatedEvents.slice(0, 5).map((event) => event.title),
  ];

  return {
    id: workItem.id,
    provider: workItem.provider,
    title: workItem.title,
    url: workItem.url ?? "",
    status: workItem.status,
    summaryFacts,
  };
}

function summarizePersonActivity(displayName: string, metrics: Record<string, number>): string {
  const eventCount = metrics["activity.events"] ?? 0;
  if (eventCount === 0) {
    return `${displayName} had no observed activity in this period.`;
  }

  return `${displayName} had ${eventCount} observed activity events in this period.`;
}
