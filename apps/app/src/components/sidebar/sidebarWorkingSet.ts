import type { ThreadListEntry } from "@bb/domain";
import {
  hasActiveBackgroundAgentActivity,
  hasActiveBackgroundCommandActivity,
  hasActiveGoalActivity,
  hasActivePlanModeActivity,
  hasActiveWorkflowActivity,
  isRuntimeBusyThread,
} from "@/lib/thread-activity";

export const SIDEBAR_WORKING_SET_LIMIT = 12;
export const SIDEBAR_WORKING_SET_RECENT_MS = 48 * 60 * 60 * 1000;

export type SidebarWorkingSetMode = "working" | "all";

export interface SidebarWorkingSet {
  olderThreadCount: number;
  threads: ThreadListEntry[];
}

function compareWorkingSetThreads(
  left: ThreadListEntry,
  right: ThreadListEntry,
): number {
  const pinnedAtDelta = (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0);
  if (pinnedAtDelta !== 0) return pinnedAtDelta;

  const latestAttentionAtDelta =
    right.latestAttentionAt - left.latestAttentionAt;
  if (latestAttentionAtDelta !== 0) return latestAttentionAtDelta;

  const updatedAtDelta = right.updatedAt - left.updatedAt;
  if (updatedAtDelta !== 0) return updatedAtDelta;

  return left.id.localeCompare(right.id);
}

export function hasSidebarWorkingActivity(thread: ThreadListEntry): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.status === "active" ||
    isRuntimeBusyThread(thread) ||
    hasActiveWorkflowActivity(thread) ||
    hasActiveBackgroundAgentActivity(thread) ||
    hasActiveBackgroundCommandActivity(thread) ||
    hasActivePlanModeActivity(thread) ||
    hasActiveGoalActivity(thread)
  );
}

function belongsInWorkingSet(
  thread: ThreadListEntry,
  recentSince: number,
): boolean {
  return (
    thread.pinnedAt !== null ||
    hasSidebarWorkingActivity(thread) ||
    thread.updatedAt >= recentSince
  );
}

export function buildSidebarWorkingSet({
  mode,
  now = Date.now(),
  pinnedThreadIds,
  threads,
}: {
  mode: SidebarWorkingSetMode;
  now?: number;
  /** Includes pinned descendants, which must remain visible with their root. */
  pinnedThreadIds?: ReadonlySet<string>;
  threads: readonly ThreadListEntry[];
}): SidebarWorkingSet {
  if (mode === "all") {
    return { olderThreadCount: 0, threads: [...threads] };
  }

  const recentSince = now - SIDEBAR_WORKING_SET_RECENT_MS;
  const pinnedThreads = threads.filter(
    (thread) =>
      pinnedThreadIds?.has(thread.id) === true || thread.pinnedAt !== null,
  );
  const pinnedThreadIdSet = new Set(pinnedThreads.map((thread) => thread.id));
  const activeThreads = threads.filter(
    (thread) =>
      !pinnedThreadIdSet.has(thread.id) && hasSidebarWorkingActivity(thread),
  );
  const recentThreads = threads.filter(
    (thread) =>
      !pinnedThreadIdSet.has(thread.id) &&
      !hasSidebarWorkingActivity(thread) &&
      belongsInWorkingSet(thread, recentSince),
  );

  // Pinned and active work are non-negotiable: the numeric limit only bounds
  // idle recents. A busy thread must never disappear behind a full sidebar.
  const alwaysVisible = [...pinnedThreads, ...activeThreads].sort(
    compareWorkingSetThreads,
  );
  const recentCapacity = Math.max(
    0,
    SIDEBAR_WORKING_SET_LIMIT - alwaysVisible.length,
  );
  const visibleThreads = [
    ...alwaysVisible,
    ...recentThreads.sort(compareWorkingSetThreads).slice(0, recentCapacity),
  ];
  return {
    olderThreadCount: Math.max(0, threads.length - visibleThreads.length),
    threads: visibleThreads,
  };
}
