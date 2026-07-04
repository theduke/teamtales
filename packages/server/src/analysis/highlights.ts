import type { ActivityEvent, Highlight, HighlightType, WorkItem } from "./types.js";
import { isAutomatedEvent } from "./metrics.js";

export type HighlightScoringOptions = {
  periodStart: string;
  periodEnd: string;
  manuallyPinnedWorkItemIds?: readonly string[];
  maxHighlights?: number;
};

type WorkActivity = {
  events: ActivityEvent[];
  people: Set<string>;
  sourceRefs: Set<string>;
};

export function scoreHighlights(
  workItems: readonly WorkItem[],
  events: readonly ActivityEvent[],
  options: HighlightScoringOptions,
): Highlight[] {
  const activityByWorkItem = groupActivityByWorkItem(events);
  const pinned = new Set(options.manuallyPinnedWorkItemIds ?? []);

  return workItems
    .map((workItem) => scoreWorkItem(workItem, activityByWorkItem.get(workItem.id), pinned, options))
    .filter((highlight): highlight is Highlight => highlight !== undefined)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, options.maxHighlights ?? 10);
}

function scoreWorkItem(
  workItem: WorkItem,
  activity: WorkActivity | undefined,
  pinned: ReadonlySet<string>,
  options: HighlightScoringOptions,
): Highlight | undefined {
  const reason: string[] = [];
  let score = 0;
  let highlightType: HighlightType | undefined;

  if (workItem.status === "completed" && happenedInPeriod(workItem.completedAt, options)) {
    score += 35;
    highlightType = "completed_work";
    reason.push("Work item completed during this period");
  }

  if (workItem.status === "merged" && happenedInPeriod(workItem.completedAt, options)) {
    score += 35;
    highlightType = "merged_pr";
    reason.push("Pull request merged during this period");
  }

  const nonAutomatedEvents = activity?.events.filter((event) => !isAutomatedEvent(event)) ?? [];
  const discussionEvents = nonAutomatedEvents.filter((event) =>
    event.eventType.includes("comment") || event.eventType.includes("review"),
  );

  if (discussionEvents.length >= 5) {
    score += 20;
    highlightType ??= "active_discussion";
    reason.push(`Active discussion with ${discussionEvents.length} comments or reviews`);
  }

  const contributorCount = activity?.people.size ?? 0;
  if (contributorCount >= 3) {
    score += 15;
    highlightType ??= "cross_team_collaboration";
    reason.push(`Touched by ${contributorCount} people`);
  }

  if (workItem.linearProjectId !== undefined) {
    score += 10;
    highlightType ??= "project_progress";
    reason.push("Linked to a Linear project");
  }

  if (isLongRunningCompletion(workItem, options)) {
    score += 15;
    highlightType = "long_running_item_completed";
    reason.push("Long-running item completed");
  }

  if (pinned.has(workItem.id)) {
    score += 25;
    reason.push("Manually pinned by a user");
  }

  if (isLowSignalMaintenance(workItem, nonAutomatedEvents)) {
    score -= 15;
    reason.push("Low-signal maintenance work");
  }

  if (nonAutomatedEvents.length === 0 && !pinned.has(workItem.id)) {
    score -= 10;
    reason.push("No observed human activity during this period");
  }

  if (score <= 0 || highlightType === undefined) {
    return undefined;
  }

  return {
    workItemId: workItem.id,
    highlightType,
    score: Math.max(0, Math.min(100, score)),
    title: workItem.title,
    reason,
    sourceRefs: [...(activity?.sourceRefs ?? new Set<string>())].sort(),
    relatedPeople: [...(activity?.people ?? new Set<string>())].sort(),
    relatedWorkItems: [workItem.id, ...(workItem.linkedWorkItemIds ?? [])],
  };
}

export function detectRisks(workItems: readonly WorkItem[], events: readonly ActivityEvent[], now: string): Highlight[] {
  const activityByWorkItem = groupActivityByWorkItem(events);
  const nowTime = Date.parse(now);

  return workItems.flatMap((workItem) => {
    const updatedAt = Date.parse(workItem.updatedAtSource ?? workItem.startedAt ?? workItem.createdAtSource ?? "");
    const ageDays = Number.isFinite(updatedAt) ? (nowTime - updatedAt) / 86_400_000 : 0;

    if ((workItem.status === "open" || workItem.status === "in_progress") && ageDays >= 14) {
      const activity = activityByWorkItem.get(workItem.id);
      return [{
        workItemId: workItem.id,
        highlightType: "potential_blocker" as const,
        score: Math.min(100, 40 + Math.floor(ageDays)),
        title: workItem.title,
        reason: [`Open for ${Math.floor(ageDays)} days without completion`],
        sourceRefs: [...(activity?.sourceRefs ?? new Set<string>())].sort(),
        relatedPeople: [...(activity?.people ?? new Set<string>())].sort(),
        relatedWorkItems: [workItem.id],
      }];
    }

    return [];
  });
}

function groupActivityByWorkItem(events: readonly ActivityEvent[]): Map<string, WorkActivity> {
  const byWorkItem = new Map<string, WorkActivity>();

  for (const event of events) {
    if (event.workItemId === undefined) {
      continue;
    }

    const activity = byWorkItem.get(event.workItemId) ?? {
      events: [],
      people: new Set<string>(),
      sourceRefs: new Set<string>(),
    };

    activity.events.push(event);

    if (event.actorPersonId !== undefined && !isAutomatedEvent(event)) {
      activity.people.add(event.actorPersonId);
    }

    activity.sourceRefs.add(event.sourceRef ?? `activity_event:${event.id}`);
    byWorkItem.set(event.workItemId, activity);
  }

  return byWorkItem;
}

function happenedInPeriod(value: string | undefined, options: HighlightScoringOptions): boolean {
  if (value === undefined) {
    return false;
  }

  const time = Date.parse(value);
  return time >= Date.parse(options.periodStart) && time < Date.parse(options.periodEnd);
}

function isLongRunningCompletion(workItem: WorkItem, options: HighlightScoringOptions): boolean {
  if (!happenedInPeriod(workItem.completedAt, options) || workItem.startedAt === undefined || workItem.completedAt === undefined) {
    return false;
  }

  return Date.parse(workItem.completedAt) - Date.parse(workItem.startedAt) >= 14 * 86_400_000;
}

function isLowSignalMaintenance(workItem: WorkItem, events: readonly ActivityEvent[]): boolean {
  const text = `${workItem.title} ${(workItem.labels ?? []).join(" ")}`.toLowerCase();
  const maintenance = text.includes("typo") || text.includes("chore") || text.includes("dependency");
  return maintenance && events.length <= 1;
}
