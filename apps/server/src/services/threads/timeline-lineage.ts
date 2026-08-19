import { getLatestThreadSequence } from "@bb/db";
import type { ProviderComposerCommand, Thread } from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { findLineagePredecessor } from "./thread-lineage.js";
import {
  buildLineageCursorAnchorId,
  readLineageCursor,
  type LineageCursorTarget,
} from "./timeline-pagination.js";
import {
  buildThreadTimelineWithProfile,
  type ThreadTimelinePageRequest,
} from "./timeline.js";

/**
 * Lineage-aware timeline continuation.
 *
 * Prior-lineage rows arrive through the SAME `GET /threads/:id/timeline` call
 * the client already makes, in the same scroll container, because the server
 * keeps paging past the start of the requested thread into the thread it
 * retired. `useThreadTimelineController` and every other paging consumer is
 * untouched: they keep sending one `threadId` and one cursor.
 *
 * Rows already carry their own `threadId` (`TimelineRow.threadId`), so the app
 * can tell a predecessor row from a current one without a contract change.
 */

/**
 * How far back a cursor may name a predecessor. The chain is walked on every
 * page — this is an authorization check, not a convenience — so it is bounded.
 */
const MAX_LINEAGE_PAGE_DEPTH = 32;

export interface LineageTimelinePageDeps
  extends Pick<AppDeps, "config" | "db" | "providerRegistry"> {}

export interface ResolvedLineagePage {
  /** The predecessor thread whose rows this page serves. */
  thread: Thread;
  /** Its own page request, translated out of the lineage cursor. */
  page: ThreadTimelinePageRequest;
}

/**
 * Translates an incoming cursor into a predecessor page, or returns null when
 * the cursor belongs to the requested thread itself.
 *
 * The authorization is the walk: the named thread must be reachable from the
 * requested thread by following lineage edges BACKWARD, and every hop is
 * project-scoped by `findLineagePredecessor`. Without that, a lineage cursor
 * would be a cross-project read primitive — it is the one place a timeline
 * request names a thread other than its own path parameter.
 */
export function resolveLineageTimelinePage(
  db: LineageTimelinePageDeps["db"],
  args: {
    thread: Thread;
    page: ThreadTimelinePageRequest;
  },
): ResolvedLineagePage | null {
  if (args.page.kind !== "older") {
    return null;
  }
  const target = readLineageCursor(args.page.beforeCursor);
  if (target === null) {
    return null;
  }

  const predecessor = requireReachablePredecessor(db, {
    predecessorThreadId: target.threadId,
    thread: args.thread,
  });
  return {
    thread: predecessor,
    page: toPredecessorPageRequest(target, args.page.segmentLimit),
  };
}

function toPredecessorPageRequest(
  target: LineageCursorTarget,
  segmentLimit: number,
): ThreadTimelinePageRequest {
  // No inner cursor means this is the first page across the seam, which is the
  // NEWEST page of the predecessor — the rows immediately above the current
  // thread's oldest row.
  return target.innerCursor === null
    ? { kind: "latest", segmentLimit }
    : { beforeCursor: target.innerCursor, kind: "older", segmentLimit };
}

function requireReachablePredecessor(
  db: LineageTimelinePageDeps["db"],
  args: { predecessorThreadId: string; thread: Thread },
): Thread {
  let cursor: Thread = args.thread;
  for (let depth = 0; depth < MAX_LINEAGE_PAGE_DEPTH; depth += 1) {
    const predecessor = findLineagePredecessor(db, cursor);
    if (predecessor === null) {
      break;
    }
    if (predecessor.id === args.predecessorThreadId) {
      return predecessor;
    }
    cursor = predecessor;
  }
  // Deliberately the same shape as an expired cursor rather than a 403: a
  // cursor that names a thread which is not a predecessor is either stale (the
  // edge was cleared) or forged, and neither deserves a distinguishable answer.
  throw new ApiError(
    400,
    "invalid_request",
    "Timeline pagination cursor is no longer available",
  );
}

/**
 * The cursor that continues an exhausted thread into the thread it retired, or
 * null when there is nothing above it. Called only when the thread's own
 * pagination reported no older rows.
 */
export function buildLineageContinuationCursor(
  db: LineageTimelinePageDeps["db"],
  thread: Thread,
): { anchorId: string; anchorSeq: number } | null {
  const predecessor = findLineagePredecessor(db, thread);
  if (predecessor === null) {
    return null;
  }
  const maxSeq = getLatestThreadSequence(db, { threadId: predecessor.id });
  if (maxSeq <= 0) {
    // An empty predecessor has nothing to show, and `anchorSeq` must be
    // positive. Stop here rather than emitting a cursor that returns nothing.
    return null;
  }
  return {
    anchorId: buildLineageCursorAnchorId({
      threadId: predecessor.id,
      innerAnchorId: null,
    }),
    anchorSeq: maxSeq,
  };
}

export interface BuildLineageTimelinePageArgs {
  eventBudget: number;
  includeNestedRows: boolean;
  includeProviderUnhandledOperations: boolean;
  maxInlineOutputChars: number;
  page: ThreadTimelinePageRequest;
  /** The predecessor's own plan command, NOT the requested thread's. */
  planCommand: ProviderComposerCommand | null;
  /** The predecessor's own display name, NOT the requested thread's. */
  providerDisplayName: string | undefined;
  /**
   * The REQUESTED thread's high-water sequence. Echoed back untouched: the
   * client uses `maxSeq` for its delta bookkeeping against the thread it
   * asked for, and reporting the predecessor's sequence would corrupt it.
   */
  requestedThreadMaxSeq: number;
  summaryOnly: boolean;
  /** The predecessor whose rows this page serves. */
  thread: Thread;
}

/**
 * Projects a predecessor's timeline page and re-tags its cursors so the next
 * request stays on the lineage path. When the predecessor is itself exhausted,
 * the page continues into ITS predecessor, so a chain of any length pages
 * through one route.
 */
export function buildLineageTimelinePage(
  db: LineageTimelinePageDeps["db"],
  args: BuildLineageTimelinePageArgs,
): ThreadTimelineResponse {
  const maxSeq = getLatestThreadSequence(db, { threadId: args.thread.id });
  const { response } = buildThreadTimelineWithProfile(db, args.thread, {
    eventBudget: args.eventBudget,
    includeNestedRows: args.includeNestedRows,
    includeProviderUnhandledOperations: args.includeProviderUnhandledOperations,
    maxInlineOutputChars: args.maxInlineOutputChars,
    maxSeq,
    page: args.page,
    ...(args.providerDisplayName !== undefined
      ? { providerDisplayName: args.providerDisplayName }
      : {}),
    planCommand: args.planCommand,
    summaryOnly: args.summaryOnly,
  });

  const ownCursor = response.timelinePage.olderCursor;
  const nextCursor =
    ownCursor === null
      ? buildLineageContinuationCursor(db, args.thread)
      : {
          anchorId: buildLineageCursorAnchorId({
            threadId: args.thread.id,
            innerAnchorId: ownCursor.anchorId,
          }),
          anchorSeq: ownCursor.anchorSeq,
        };

  return {
    ...response,
    maxSeq: args.requestedThreadMaxSeq,
    timelinePage: {
      ...response.timelinePage,
      hasOlderRows: nextCursor !== null,
      olderCursor: nextCursor,
    },
  };
}
