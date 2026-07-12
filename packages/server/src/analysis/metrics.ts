import type { ActivityEvent, Metric } from "./types.js";

export function eventsInPeriod(
  events: readonly ActivityEvent[],
  start: string,
  end: string,
): ActivityEvent[] {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);

  return events.filter((event) => {
    const occurredAt = Date.parse(event.occurredAt);
    return occurredAt >= startTime && occurredAt < endTime;
  });
}

export function computeActivityMetrics(events: readonly ActivityEvent[]): Metric[] {
  const metrics = new Map<string, number>();
  const contributors = new Set<string>();

  for (const event of events) {
    increment(metrics, metricNameForEvent(event.eventType));

    if (event.actorPersonId !== undefined && !isAutomatedEvent(event)) {
      contributors.add(event.actorPersonId);
    }
  }

  if (contributors.size > 0) {
    metrics.set("people.active_contributors", contributors.size);
  }

  return [...metrics.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
}

export function computePersonMetrics(
  events: readonly ActivityEvent[],
): Map<string, Record<string, number>> {
  const byPerson = new Map<string, Record<string, number>>();

  for (const event of events) {
    if (event.actorPersonId === undefined || isAutomatedEvent(event)) {
      continue;
    }

    const metrics = byPerson.get(event.actorPersonId) ?? {};
    const name = metricNameForEvent(event.eventType);
    metrics[name] = (metrics[name] ?? 0) + 1;
    metrics["activity.events"] = (metrics["activity.events"] ?? 0) + 1;
    byPerson.set(event.actorPersonId, metrics);
  }

  return byPerson;
}

export function metricNameForEvent(eventType: string): string {
  switch (eventType) {
    case "github.pr_opened":
      return "github.prs_opened";
    case "github.pr_merged":
      return "github.prs_merged";
    case "github.pr_reviewed":
      return "github.prs_reviewed";
    case "github.pr_commented":
    case "github.pr_review_commented":
      return "github.pr_comments";
    case "linear.issue_created":
      return "linear.issues_created";
    case "linear.issue_completed":
      return "linear.issues_completed";
    case "linear.issue_updated":
    case "linear.issue_assigned":
    case "linear.issue_status_changed":
      return "linear.issues_updated";
    case "linear.issue_commented":
      return "linear.comments_created";
    default:
      return `activity.${eventType}`;
  }
}

export function isAutomatedEvent(event: ActivityEvent): boolean {
  return event.metadata?.["actorType"] === "bot" || event.metadata?.["automated"] === true;
}

function increment(metrics: Map<string, number>, name: string, amount = 1): void {
  metrics.set(name, (metrics.get(name) ?? 0) + amount);
}
