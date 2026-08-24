import { describe, expect, it } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";
import type { TimelineEventFactory } from "./timeline-test-harness.js";

type TimelineFixtureEvent = ReturnType<
  TimelineEventFactory[keyof TimelineEventFactory]
>;
type TimelineChildSessionRow = Extract<
  TimelineRow,
  { kind: "work"; workKind: "child-session" }
>;

function renderIdleTimeline(events: TimelineFixtureEvent[]) {
  return renderTimelineFixture({
    events,
    projectionOptions: {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    },
  });
}

function findChildSessionRows(
  rows: readonly TimelineRow[],
): TimelineChildSessionRow[] {
  const found: TimelineChildSessionRow[] = [];
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "child-session") {
      found.push(row);
    }
    if (row.kind === "turn" && row.children) {
      found.push(...findChildSessionRows(row.children));
    }
  }
  return found;
}

function findTurnRow(
  rows: readonly TimelineRow[],
  turnId: string,
): Extract<TimelineRow, { kind: "turn" }> | undefined {
  return rows.find(
    (row): row is Extract<TimelineRow, { kind: "turn" }> =>
      row.kind === "turn" && row.turnId === turnId,
  );
}

describe("child session lifecycle folding", () => {
  it("keeps the spawning turn's source range pinned when the child completes during a later turn", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted({ createdAt: 1_000 }),
      event.childSessionLifecycle({
        createdAt: 2_000,
        model: "gpt-5",
        status: "started",
        turnId: "turn-1",
      }),
      event.turnCompleted({ createdAt: 3_000 }),
      event.turnStarted({ createdAt: 4_000, turnId: "turn-2" }),
      event.turnCompleted({ createdAt: 5_000, turnId: "turn-2" }),
      event.childSessionLifecycle({
        createdAt: 6_000,
        outputExcerpt: "Review complete.",
        status: "completed",
      }),
    ]);

    // The late thread-scoped completion (seq 6) must not stretch turn-1's range
    // across turn-2's rows: turn grouping, window pagination and turn-summary
    // expansion are all keyed on these bounds.
    expect(findTurnRow(timeline.rows, "turn-1")).toMatchObject({
      sourceSeqStart: 1,
      sourceSeqEnd: 3,
    });

    const childRows = findChildSessionRows(timeline.rows);
    expect(childRows).toHaveLength(1);
    expect(childRows[0]).toMatchObject({
      childStatus: "completed",
      sourceSeqStart: 2,
      sourceSeqEnd: 2,
      status: "completed",
      turnId: "turn-1",
    });
  });

  it("reports the newest run of a child that is messaged again", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted({ createdAt: 1_000 }),
      event.childSessionLifecycle({
        createdAt: 2_000,
        status: "started",
        title: "Review worker",
        turnId: "turn-1",
      }),
      event.childSessionLifecycle({
        createdAt: 3_000,
        outputExcerpt: "First review done.",
        status: "completed",
        title: "Review worker",
      }),
      event.turnCompleted({ createdAt: 4_000 }),
      event.childSessionLifecycle({ createdAt: 5_000, status: "running" }),
      event.childSessionLifecycle({
        createdAt: 6_000,
        outputExcerpt: "Second review done.",
        status: "failed",
        statusReason: "Tests failed",
        title: "Review worker (retry)",
      }),
    ]);

    const childRows = findChildSessionRows(timeline.rows);
    expect(childRows).toHaveLength(1);
    expect(childRows[0]).toMatchObject({
      childStatus: "failed",
      outputExcerpt: "Second review done.",
      sourceSeqEnd: 2,
      // The reopened row belongs to the second run: renderers tick
      // `now - startedAt` while it is non-terminal, so it must not keep the
      // first spawn's start and count the idle gap as elapsed work.
      startedAt: 5_000,
      status: "error",
      statusReason: "Tests failed",
      title: "Review worker (retry)",
    });
  });

  it("keeps the spawn time as the child row's start", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted({ createdAt: 1_000 }),
      event.childSessionLifecycle({
        createdAt: 2_000,
        status: "started",
        turnId: "turn-1",
      }),
      event.childSessionLifecycle({ createdAt: 9_000, status: "completed" }),
    ]);

    const childRows = findChildSessionRows(timeline.rows);
    expect(childRows).toHaveLength(1);
    expect(childRows[0]).toMatchObject({
      completedAt: 9_000,
      startedAt: 2_000,
    });
  });
});
