import { describe, expect, it } from "vitest";
import {
  events,
  getThreadTurnRecord,
  listThreadTurnRecords,
  threads,
} from "@bb/db";
import { and, eq } from "drizzle-orm";
import { turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import {
  applyTurnCompletedEvent,
  backfillThreadTurnRecords,
} from "../../src/internal/turn-completed-events.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

async function postEventBatch(args: {
  events: Parameters<typeof groupHostDaemonEvents>[0];
  harness: TestAppHarness;
  sessionId: string;
}) {
  return args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
    }),
  });
}

async function seedTelemetryThread(
  harness: TestAppHarness,
  args: { status?: "idle" | "active" } = {},
) {
  const { session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: session.hostId,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: session.hostId,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: args.status ?? "active",
  });
  return { session, project, environment, thread };
}

describe("turn telemetry write seam on turn completion", () => {
  it("materializes exactly one turn record for a root turn completion", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = await seedTelemetryThread(harness);

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "item/started",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
              item: { type: "toolCall", id: "call-1", tool: "Bash", status: "pending" },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "item/completed",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
              item: { type: "toolCall", id: "call-1", tool: "Bash", status: "completed" },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      const record = getThreadTurnRecord(harness.db, { threadId: thread.id, turnId: "turn-1" });
      expect(record).not.toBeNull();
      expect(record?.isRoot).toBe(true);
      expect(record?.status).toBe("completed");
      expect(record?.counts.toolCalls).toBe(1);
      expect(listThreadTurnRecords(harness.db, { threadId: thread.id })).toHaveLength(1);
    });
  });

  it("keeps exactly one record when a completed turn's events are redelivered", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = await seedTelemetryThread(harness);

      const turnEvents = [
        {
          threadId: thread.id,
          event: {
            type: "turn/started" as const,
            threadId: thread.id,
            providerThreadId: "provider-1",
            scope: turnScope("turn-redelivered"),
          },
        },
        {
          threadId: thread.id,
          event: {
            type: "turn/completed" as const,
            threadId: thread.id,
            providerThreadId: "provider-1",
            scope: turnScope("turn-redelivered"),
            status: "completed" as const,
          },
        },
      ];

      const first = await postEventBatch({ harness, sessionId: session.id, events: turnEvents });
      expect(first.status).toBe(200);
      const second = await postEventBatch({ harness, sessionId: session.id, events: turnEvents });
      expect(second.status).toBe(200);

      const records = listThreadTurnRecords(harness.db, { threadId: thread.id }).filter(
        (record) => record.turnId === "turn-redelivered",
      );
      expect(records).toHaveLength(1);
    });
  });

  it("materializes a non-root record for a nested subagent turn without touching the parent's lifecycle", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = await seedTelemetryThread(harness, { status: "active" });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("root-turn"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("nested-turn"),
              parentToolCallId: "call-delegate",
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("nested-turn"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      const record = getThreadTurnRecord(harness.db, { threadId: thread.id, turnId: "nested-turn" });
      expect(record).not.toBeNull();
      expect(record?.isRoot).toBe(false);
      expect(record?.parentToolCallId).toBe("call-delegate");
      // A nested turn completion is not a root completion: it must not settle
      // the thread's own run lifecycle.
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()?.status,
      ).toBe("active");
    });
  });

  it("proceeds with the completion lifecycle even when the telemetry builder throws", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness, { status: "active" });
      const turnId = "turn-builder-throws";

      // A durable turn/started exists so this reads as a root completion, but
      // no turn/completed row is ever stored for it. Calling
      // applyTurnCompletedEvent directly with a completed-turn payload for
      // this turnId reproduces exactly the situation its try/catch guards:
      // buildThreadTurnRecord throws "has no durable completion event"
      // because listStoredEventRowsForTurn will not find one.
      seedEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1" },
      });

      const result = applyTurnCompletedEvent(harness.deps, {
        type: "turn/completed",
        threadId: thread.id,
        providerThreadId: "provider-1",
        scope: turnScope(turnId),
        status: "completed",
      });

      expect(result.turn).toBeNull();
      expect(result.isRootTurnCompletion).toBe(true);
      expect(result.nextStatus).toBe("idle");
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()?.status,
      ).toBe("idle");
      expect(getThreadTurnRecord(harness.db, { threadId: thread.id, turnId })).toBeNull();
    });
  });

  it("backfills turn records from durable completion events without settling lifecycle state", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness, { status: "active" });
      const turnId = "turn-backfill";
      seedEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "turn/completed",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const result = await backfillThreadTurnRecords(harness.deps);

      expect(result.inspected).toBe(1);
      expect(result.materialized).toBe(1);
      expect(getThreadTurnRecord(harness.db, { threadId: thread.id, turnId })).not.toBeNull();
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()?.status,
      ).toBe("active");
    });
  });

  it("never rebuilds a turn that already has a record, even after pruning stripped its detail", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = await seedTelemetryThread(harness);

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-materialized"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "item/started",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-materialized"),
              item: { type: "toolCall", id: "call-1", tool: "Bash", status: "pending" },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "item/completed",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-materialized"),
              item: { type: "toolCall", id: "call-1", tool: "Bash", status: "completed" },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-materialized"),
              status: "completed",
            },
          },
        ],
      });
      expect(response.status).toBe(200);
      expect(
        getThreadTurnRecord(harness.db, {
          threadId: thread.id,
          turnId: "turn-materialized",
        })?.counts.toolCalls,
      ).toBe(1);

      // Idle pruning removes the detail events the record was built from, so a
      // rebuild could only produce a poorer record than the durable one.
      harness.db
        .delete(events)
        .where(and(eq(events.threadId, thread.id), eq(events.itemId, "call-1")))
        .run();

      const result = await backfillThreadTurnRecords(harness.deps);

      // The completion already has a record, so it is not even a candidate.
      expect(result).toEqual({ inspected: 0, materialized: 0 });
      expect(
        getThreadTurnRecord(harness.db, {
          threadId: thread.id,
          turnId: "turn-materialized",
        })?.counts.toolCalls,
      ).toBe(1);
    });
  });
});
