import type { ThreadListEntry } from "@bb/domain";
import { isRuntimeBusyThread } from "@/lib/thread-activity";

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

function belongsInWorkingSet(
  thread: ThreadListEntry,
  recentSince: number,
): boolean {
  return (
    thread.pinnedAt !== null ||
    thread.hasPendingInteraction ||
    isRuntimeBusyThread(thread) ||
    thread.status === "active" ||
    thread.updatedAt >= recentSince
  );
}

export function buildSidebarWorkingSet({
  mode,
  now = Date.now(),
  threads,
}: {
  mode: SidebarWorkingSetMode;
  now?: number;
  threads: readonly ThreadListEntry[];
}): SidebarWorkingSet {
  if (mode === "all") {
    return { olderThreadCount: 0, threads: [...threads] };
  }

  const workingThreads = threads
    .filter((thread) =>
      belongsInWorkingSet(thread, now - SIDEBAR_WORKING_SET_RECENT_MS),
    )
    .sort(compareWorkingSetThreads);

  const visibleThreads = workingThreads.slice(0, SIDEBAR_WORKING_SET_LIMIT);
  return {
    olderThreadCount: Math.max(0, threads.length - visibleThreads.length),
    threads: visibleThreads,
  };
}
