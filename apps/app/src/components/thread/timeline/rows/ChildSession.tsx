import type { MouseEvent } from "react";
import type { TimelineViewWorkRow } from "@bb/thread-view";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { useThread } from "@/hooks/queries/thread-queries";
import { useThreadDetailRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { NESTED_TIMELINE_GROUP_LINE_CLASS_NAME } from "../timeline-nested-group-line.js";
import { TimelineDetailScroll } from "../TimelineDetailScroll.js";
import { ThreadTimelinePanelContent } from "../ThreadTimelinePanelContent.js";

export type ChildSessionWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "child-session" }
>;

interface ChildSessionCollapsedPreviewProps {
  row: ChildSessionWorkRow;
}

interface ChildSessionRowBodyProps {
  row: ChildSessionWorkRow;
}

type ChildSessionStatus = ChildSessionWorkRow["childStatus"];

const CHILD_SESSION_STATUS_LABELS: Record<ChildSessionStatus, string> = {
  started: "Starting",
  running: "Working",
  "needs-attention": "Needs attention",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Stopped",
};

function isTerminalChildSessionStatus(status: ChildSessionStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "interrupted"
  );
}

function liveChildSessionStatus({
  childStatus,
  runtimeDisplayStatus,
}: {
  childStatus: ChildSessionStatus;
  runtimeDisplayStatus: string | undefined;
}): ChildSessionStatus {
  switch (runtimeDisplayStatus) {
    case "starting":
    case "provisioning":
      return "started";
    case "active":
    case "host-reconnecting":
      return "running";
    case "error":
      return "failed";
    default:
      return childStatus;
  }
}

function statusPillClassName(status: ChildSessionStatus): string {
  switch (status) {
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "needs-attention":
      return "border-warning/30 bg-warning/10 text-warning";
    case "completed":
    case "interrupted":
      return "border-border bg-surface-recessed text-muted-foreground";
    case "started":
    case "running":
      return "border-timeline-accent/30 bg-timeline-accent/10 text-timeline-accent";
  }
}

/**
 * The collapsed content remains mounted while the child transcript is closed.
 * It owns the lightweight child metadata query; the transcript itself is only
 * mounted by `ChildSessionRowBody` after the user expands the row.
 */
export function ChildSessionCollapsedPreview({
  row,
}: ChildSessionCollapsedPreviewProps) {
  const childThreadQuery = useThread(row.childThreadId);
  const stopThread = useStopThread();
  const childThread = childThreadQuery.data;
  const childStatus = liveChildSessionStatus({
    childStatus: row.childStatus,
    runtimeDisplayStatus: childThread?.runtime.displayStatus,
  });
  const isTerminal = isTerminalChildSessionStatus(childStatus);
  const providerAndModel = [row.providerId, row.model]
    .filter((part): part is string => typeof part === "string")
    .join(" · ");
  const isStopping =
    childThread?.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === row.childThreadId);

  const handleStop = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    stopThread.mutate(row.childThreadId);
  };

  return (
    <span
      className="flex min-w-0 items-center gap-2 pl-5 text-xs text-muted-foreground"
      data-testid={`child-session-preview-${row.childThreadId}`}
    >
      {providerAndModel.length > 0 ? (
        <span className="min-w-0 truncate">{providerAndModel}</span>
      ) : null}
      <span
        className={cn(
          "shrink-0 rounded-full border px-1.5 py-0.5 font-medium",
          statusPillClassName(childStatus),
        )}
      >
        {CHILD_SESSION_STATUS_LABELS[childStatus]}
      </span>
      {!isTerminal ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isStopping}
          onClick={handleStop}
          className="ml-auto h-5 shrink-0 px-1.5 text-xs"
        >
          {isStopping ? "Stopping" : "Stop"}
        </Button>
      ) : null}
    </span>
  );
}

/**
 * This component only exists while the parent disclosure is expanded. Keeping
 * the subscription here prevents a parent with many workers from opening a
 * child timeline connection and query for every collapsed row.
 */
export function ChildSessionRowBody({ row }: ChildSessionRowBodyProps) {
  useThreadDetailRealtimeSubscription(row.childThreadId);

  return (
    <TimelineDetailScroll
      size="delegation"
      streaming={!isTerminalChildSessionStatus(row.childStatus)}
      contentKey={`${row.childThreadId}|${row.childStatus}|${row.outputExcerpt?.length ?? 0}`}
      className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
    >
      <ThreadTimelinePanelContent
        threadId={row.childThreadId}
        surfaceKey={`child-session:${row.id}`}
      />
    </TimelineDetailScroll>
  );
}
