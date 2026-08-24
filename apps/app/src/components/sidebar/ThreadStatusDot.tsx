import type { Thread, ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  hasActiveBackgroundAgentActivity,
  hasActiveWorkflowActivity,
  isRuntimeBusyThread,
} from "@/lib/thread-activity";
import { isThreadRead } from "@/lib/thread-read-state";

type ThreadStatusDotShape = Pick<
  ThreadListEntry,
  "activity" | "hasPendingInteraction"
> &
  Pick<Thread, "lastReadAt" | "latestAttentionAt"> &
  Pick<ThreadWithRuntime, "runtime">;

export type ThreadStatusDotKind =
  | "running"
  | "needs-input"
  | "background-work"
  | "unread"
  | "none";

/**
 * Priority order for the leading-slot status dot. Stronger states short-
 * circuit weaker ones: a running+unread thread shows "running", not "unread".
 */
export function resolveThreadStatusDotKind(
  thread: ThreadStatusDotShape,
): ThreadStatusDotKind {
  if (isRuntimeBusyThread(thread)) {
    return "running";
  }
  if (thread.hasPendingInteraction) {
    return "needs-input";
  }
  if (
    hasActiveBackgroundAgentActivity(thread) ||
    hasActiveWorkflowActivity(thread)
  ) {
    return "background-work";
  }
  if (!isThreadRead(thread)) {
    return "unread";
  }
  return "none";
}

const THREAD_STATUS_DOT_LABEL: Record<
  Exclude<ThreadStatusDotKind, "none">,
  string
> = {
  running: "Thread running",
  "needs-input": "Thread needs input",
  "background-work": "Background work running",
  unread: "Unread thread",
};

/**
 * 6px leading-slot glyph summarizing a thread row's status at a glance,
 * independent of the richer trailing-indicator glyph system in
 * `ThreadRow.tsx`. Renders nothing for an idle, read thread so the leading
 * slot stays visually quiet.
 */
export function ThreadStatusDot({
  thread,
}: {
  thread: ThreadStatusDotShape;
}) {
  const kind = resolveThreadStatusDotKind(thread);
  if (kind === "none") {
    return null;
  }

  const label = THREAD_STATUS_DOT_LABEL[kind];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            kind === "running" && "motion-safe:animate-pulse bg-attention",
            kind === "needs-input" && "border border-warning bg-transparent",
            kind === "background-work" && "bg-attention/50",
            kind === "unread" && "bg-attention",
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
