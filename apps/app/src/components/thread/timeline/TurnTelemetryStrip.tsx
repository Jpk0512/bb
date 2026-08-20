import { useState } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { Pill } from "@bb/shared-ui/pill";
import { useThreadTurns } from "@/hooks/queries/thread-queries";
import { TurnWaterfall } from "./TurnWaterfall.js";

export interface TurnTelemetryStripProps {
  threadId: string;
  turnId: string;
}

const TELEMETRY_PILL_CLASS_NAME =
  "gap-1 rounded-md border-border/40 bg-surface-recessed/45 px-2 py-1 text-2xs font-medium leading-none text-subtle-foreground shadow-none";

/** Formats a millisecond duration the same way the "Worked for (…)" turn header does. */
export function formatTurnTelemetryDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/** Formats a token count compactly (e.g. "12.4K", "1.2M") for the telemetry chip. */
export function formatTurnTelemetryTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

function turnErrorLabel(counts: { errors: number }, status: string): string {
  if (counts.errors > 0) {
    return counts.errors === 1 ? "1 error" : `${counts.errors} errors`;
  }
  return status === "interrupted" ? "Interrupted" : "Failed";
}

/**
 * Per-turn telemetry strip rendered as the collapsed preview of a "turn" row
 * (see ThreadTimelineRows's `case "turn"` wiring). Shows duration, a token
 * usage chip (omitted entirely when no usage data is available, e.g. ACP
 * providers), and an error/interrupted indicator; expanding it lazily fetches
 * and reveals the span waterfall for the turn.
 */
export function TurnTelemetryStrip({ threadId, turnId }: TurnTelemetryStripProps) {
  const [expanded, setExpanded] = useState(false);
  const { data } = useThreadTurns({ threadId, turnId, includeSpans: false });
  const turn = data?.turns[0] ?? null;
  // Spans are the expensive part of the payload, so they're fetched only once
  // the waterfall is actually shown — mirroring the timeline's lazy turn
  // summary details pattern (LazyTurnRowBody).
  const { data: detailData, isLoading: isLoadingSpans } = useThreadTurns(
    { threadId, turnId, includeSpans: true },
    { enabled: expanded },
  );
  const detailTurn = detailData?.turns[0];
  const spans = detailTurn?.spans ?? null;
  const spansTruncated = detailTurn?.spansTruncated ?? false;

  if (!turn) {
    return null;
  }

  const hasError =
    turn.status === "failed" ||
    turn.status === "interrupted" ||
    turn.counts.errors > 0;

  return (
    <div className="flex flex-col gap-1.5" data-testid="turn-telemetry-strip">
      <div className="flex flex-wrap items-center gap-1.5">
        {turn.durationMs !== null ? (
          <Pill
            variant="outline"
            size="sm"
            className={TELEMETRY_PILL_CLASS_NAME}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="Clock" className="size-3" aria-hidden />
              {formatTurnTelemetryDuration(turn.durationMs)}
            </span>
          </Pill>
        ) : null}
        {turn.usage.source !== "none" && turn.usage.totalTokens !== null ? (
          <Pill
            variant="outline"
            size="sm"
            className={TELEMETRY_PILL_CLASS_NAME}
            aria-label={`${turn.usage.totalTokens.toLocaleString()} tokens`}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="Zap" className="size-3" aria-hidden />
              {formatTurnTelemetryTokenCount(turn.usage.totalTokens)} tokens
            </span>
          </Pill>
        ) : null}
        {hasError ? (
          <Pill
            variant="destructive"
            size="sm"
            className="gap-1 rounded-md px-2 py-1 text-2xs font-medium leading-none"
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="AlertTriangle" className="size-3" aria-hidden />
              {turnErrorLabel(turn.counts, turn.status)}
            </span>
          </Pill>
        ) : null}
        <button
          type="button"
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-subtle-foreground transition-colors hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            className="size-3"
            aria-hidden
          />
          {expanded ? "Hide spans" : "Show spans"}
        </button>
      </div>
      {expanded ? (
        <TurnWaterfall
          turnStartedAt={turn.startedAt}
          turnCompletedAt={turn.completedAt}
          spans={spans}
          spansTruncated={spansTruncated}
          isLoading={isLoadingSpans && spans === null}
        />
      ) : null}
    </div>
  );
}
