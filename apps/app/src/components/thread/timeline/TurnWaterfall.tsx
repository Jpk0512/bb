import { useState, type CSSProperties } from "react";
import type { ThreadTurnSpan, ThreadTurnSpanKind } from "@bb/domain";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

export interface TurnWaterfallProps {
  /** Null while the spans-included fetch is still in flight (never fetched yet, or loading). */
  isLoading: boolean;
  spans: readonly ThreadTurnSpan[] | null;
  spansTruncated: boolean;
  turnCompletedAt: number | null;
  turnStartedAt: number;
}

interface FlattenedSpan {
  depth: number;
  span: ThreadTurnSpan;
}

// Bars derive from the --ink/--canvas anchors so they stay legible against
// every palette (Nord, Dracula, …), per this repo's UI color rules — never a
// hardcoded oklch literal. Depth is not encoded in bar color (indentation
// already carries nesting); status is.
const SPAN_BAR_COMPLETED_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklch, var(--ink) 32%, var(--canvas))",
};
const SPAN_BAR_PENDING_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklch, var(--ink) 55%, var(--canvas))",
};
const SPAN_TRACK_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklch, var(--ink) 8%, var(--canvas))",
};

const SPAN_KIND_ICON: Record<ThreadTurnSpanKind, IconName> = {
  tool: "Terminal",
  command: "Terminal",
  "file-change": "EditFile",
  delegation: "UserRoundPlus",
  "web-search": "Search",
  "web-fetch": "Globe",
  "image-view": "File",
  reasoning: "Brain",
  message: "MessageSquare",
  compaction: "Layers",
  "background-task": "ListTodo",
};

function flattenSpans(
  spans: readonly ThreadTurnSpan[],
  depth = 0,
): FlattenedSpan[] {
  const flattened: FlattenedSpan[] = [];
  for (const span of spans) {
    flattened.push({ depth, span });
    if (span.children.length > 0) {
      flattened.push(...flattenSpans(span.children, depth + 1));
    }
  }
  return flattened;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

interface SpanBarMetrics {
  leftPercent: number;
  widthPercent: number;
}

function spanBarMetrics(
  span: ThreadTurnSpan,
  turnStartedAt: number,
  totalDurationMs: number,
): SpanBarMetrics {
  if (totalDurationMs <= 0) {
    return { leftPercent: 0, widthPercent: 100 };
  }
  const leftPercent = clampPercent(
    ((span.startedAt - turnStartedAt) / totalDurationMs) * 100,
  );
  // A span with no captured duration (still pending, or an instantaneous
  // event) still needs a visible sliver rather than a zero-width bar.
  const rawWidthPercent =
    span.durationMs !== null
      ? (span.durationMs / totalDurationMs) * 100
      : 1;
  const widthPercent = clampPercent(
    Math.max(rawWidthPercent, 1),
  );
  return {
    leftPercent,
    widthPercent: Math.min(widthPercent, 100 - leftPercent),
  };
}

interface SpanRowProps {
  depth: number;
  leftPercent: number;
  span: ThreadTurnSpan;
  widthPercent: number;
}

function SpanRow({ depth, leftPercent, span, widthPercent }: SpanRowProps) {
  const [showDetail, setShowDetail] = useState(false);
  const hasDetail = Boolean(span.detail || span.error);
  const isError = span.status === "failed";
  const isPending = span.completedAt === null;

  return (
    <div className="flex flex-col gap-0.5">
      <div
        className="flex min-w-0 items-center gap-2 text-2xs"
        style={{ paddingLeft: depth * 14 }}
      >
        <Icon
          name={SPAN_KIND_ICON[span.kind] ?? "Terminal"}
          className={cn(
            "size-3 shrink-0",
            isError ? "text-destructive-text" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <button
          type="button"
          disabled={!hasDetail}
          onClick={() => setShowDetail((value) => !value)}
          className={cn(
            "min-w-0 shrink-0 truncate text-left font-medium",
            isError ? "text-destructive-text" : "text-foreground",
            hasDetail ? "cursor-pointer hover:underline" : "cursor-default",
          )}
          style={{ maxWidth: "40%" }}
        >
          {span.name}
        </button>
        <div
          className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-sm"
          style={SPAN_TRACK_STYLE}
        >
          <div
            className="absolute inset-y-0 rounded-sm"
            style={{
              left: `${leftPercent}%`,
              width: `${widthPercent}%`,
              ...(isPending ? SPAN_BAR_PENDING_STYLE : SPAN_BAR_COMPLETED_STYLE),
            }}
          />
        </div>
        <span className="shrink-0 text-subtle-foreground">
          {span.durationMs !== null ? `${Math.round(span.durationMs)}ms` : "…"}
        </span>
      </div>
      {showDetail && hasDetail ? (
        <pre
          className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card px-2 py-1.5 font-mono text-2xs leading-tight text-subtle-foreground"
          style={{ marginLeft: depth * 14 + 20 }}
        >
          {span.error ?? span.detail}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Nested-span waterfall for one turn's telemetry. Bars are positioned/sized
 * by each span's `startedAt`/`durationMs` relative to the turn's own
 * start/completion, and indented by `depth` (a span's parent is
 * `parentItemId`, walked via `children`).
 */
export function TurnWaterfall({
  isLoading,
  spans,
  spansTruncated,
  turnCompletedAt,
  turnStartedAt,
}: TurnWaterfallProps) {
  if (isLoading) {
    return (
      <div className="px-1 py-1 text-2xs text-muted-foreground">
        Loading spans…
      </div>
    );
  }
  if (spans === null) {
    return null;
  }
  if (spans.length === 0) {
    return (
      <div className="px-1 py-1 text-2xs text-muted-foreground">
        No spans recorded for this turn.
      </div>
    );
  }

  const totalDurationMs =
    (turnCompletedAt ?? spans.at(-1)?.completedAt ?? turnStartedAt) -
    turnStartedAt;
  const flattened = flattenSpans(spans);

  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-border bg-card px-2 py-2"
      data-testid="turn-waterfall"
    >
      {flattened.map(({ depth, span }) => {
        const { leftPercent, widthPercent } = spanBarMetrics(
          span,
          turnStartedAt,
          totalDurationMs,
        );
        return (
          <SpanRow
            key={span.id}
            depth={depth}
            leftPercent={leftPercent}
            span={span}
            widthPercent={widthPercent}
          />
        );
      })}
      {spansTruncated ? (
        <div className="pt-1 text-2xs text-muted-foreground">
          Some spans were truncated for this turn.
        </div>
      ) : null}
    </div>
  );
}
