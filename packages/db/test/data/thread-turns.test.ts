import { describe, expect, it } from "vitest";
import { turnScope, type ThreadTurnRecord } from "@bb/domain";
import { createConnection } from "../../src/connection.js";
import {
  getPreviousRootTurnUsage,
  getThreadTurnRecord,
  listThreadTurnRecords,
  upsertThreadTurnRecord,
} from "../../src/data/thread-turns.js";
import {
  insertEvents,
  listStoredEventRowsForTurn,
  listTurnConversationItemRows,
} from "../../src/data/events.js";
import { createProject } from "../../src/data/projects.js";
import { createThread, deleteThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "thread-turn-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "thread-turn-project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/thread-turns",
    },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, project, thread };
}

function recordFixture(args: {
  isRoot?: boolean;
  startedAt?: number;
  threadId: string;
  turnId: string;
  usageTotalTokens?: number | null;
}): ThreadTurnRecord {
  return {
    threadId: args.threadId,
    turnId: args.turnId,
    projectId: "project-telemetry",
    providerId: "codex",
    model: "gpt-5",
    modelSource: "turn-request",
    reasoningLevel: "high",
    serviceTier: "default",
    parentToolCallId: args.isRoot === false ? "tool-parent" : null,
    isRoot: args.isRoot ?? true,
    initiator: "user",
    startedAt: args.startedAt ?? 1_000,
    completedAt: (args.startedAt ?? 1_000) + 500,
    durationMs: 500,
    status: "completed",
    errorMessage: null,
    counts: {
      toolCalls: 1,
      commands: 0,
      fileChanges: 0,
      delegations: 0,
      subagentSpans: 0,
      errors: 0,
      interrupted: false,
    },
    usage: {
      totalTokens: args.usageTotalTokens ?? 10,
      inputTokens: args.usageTotalTokens ?? 10,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      modelContextWindow: 128_000,
      source: "provider-turn-delta",
      costUsd: null,
    },
    sourceSeqStart: 1,
    sourceSeqEnd: 5,
    spans: [],
    spansTruncated: false,
  };
}

describe("thread turn records", () => {
  it("upserts idempotently by thread and turn", () => {
    const { db, thread } = setup();
    const first = recordFixture({ threadId: thread.id, turnId: "turn-1" });
    const retried = {
      ...first,
      counts: { ...first.counts, errors: 1 },
      errorMessage: "A provider retry rebuilt this record",
      status: "failed" as const,
    };

    expect(upsertThreadTurnRecord(db, first)).toEqual(first);
    expect(upsertThreadTurnRecord(db, retried)).toEqual(retried);
    expect(listThreadTurnRecords(db, { threadId: thread.id })).toEqual([
      retried,
    ]);
  });

  it("cascades records when the thread is hard-deleted", () => {
    const { db, thread } = setup();
    upsertThreadTurnRecord(
      db,
      recordFixture({ threadId: thread.id, turnId: "turn-delete" }),
    );

    expect(deleteThread(db, noopNotifier, thread.id)).toBe(true);
    expect(
      getThreadTurnRecord(db, { threadId: thread.id, turnId: "turn-delete" }),
    ).toBeNull();
  });

  it("uses the prior root turn usage and skips subagent turns", () => {
    const { db, thread } = setup();
    const rootUsage = upsertThreadTurnRecord(
      db,
      recordFixture({
        threadId: thread.id,
        turnId: "root-turn",
        startedAt: 1_000,
        usageTotalTokens: 100,
      }),
    ).usage;
    upsertThreadTurnRecord(
      db,
      recordFixture({
        threadId: thread.id,
        turnId: "nested-turn",
        isRoot: false,
        startedAt: 2_000,
        usageTotalTokens: 999,
      }),
    );

    expect(
      getPreviousRootTurnUsage(db, {
        threadId: thread.id,
        beforeStartedAt: 3_000,
      }),
    ).toEqual(rootUsage);
  });

  it("reads a turn's own rows and leaves conversation text unclipped", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "agent-1",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: { id: "agent-1", type: "agentMessage", text: "full answer" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "tool-1",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({ item: { id: "tool-1", type: "toolCall" } }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/completed",
        scope: turnScope("turn-2"),
        itemId: "agent-2",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: { id: "agent-2", type: "agentMessage", text: "other turn" },
        }),
      },
    ]);

    expect(
      listStoredEventRowsForTurn(db, {
        threadId: thread.id,
        turnId: "turn-1",
        maxInlineOutputChars: null,
      }).map((row) => row.sequence),
    ).toEqual([1, 2]);
    expect(
      listTurnConversationItemRows(db, {
        threadId: thread.id,
        turnId: "turn-1",
      }).map((row) => JSON.parse(row.data).item.text),
    ).toEqual(["full answer"]);
  });
});
