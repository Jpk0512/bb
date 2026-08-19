import { describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber, threadScope } from "@bb/domain";
import type { ClientTurnRequestId, Thread } from "@bb/domain";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  migrate,
  noopNotifier,
  setThreadSupersededBy,
  upsertHost,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import {
  buildLineageContinuationCursor,
  buildLineageTimelinePage,
  resolveLineageTimelinePage,
} from "../../../src/services/threads/timeline-lineage.js";
import type { ThreadTimelinePageRequest } from "../../../src/services/threads/timeline.js";

const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
} as const;

function requestId(value: number): ClientTurnRequestId {
  return encodeClientTurnRequestIdNumber({ value });
}

interface Setup {
  db: DbConnection;
  otherProjectThread: Thread;
  /** oldest -> newest: origin retired into middle, middle retired into head. */
  chain: Thread[];
}

/** One user message per thread is enough: each is its own pagination segment. */
function seedMessages(
  db: DbConnection,
  thread: Thread,
  texts: readonly string[],
): void {
  insertEvents(
    db,
    noopNotifier,
    texts.map((text, index) => ({
      threadId: thread.id,
      sequence: index + 1,
      type: "client/turn/requested" as const,
      scope: threadScope(),
      itemId: null,
      itemKind: null,
      data: JSON.stringify({
        direction: "outbound",
        source: "spawn",
        initiator: "user",
        request: { method: "thread/start", params: {} },
        requestId: requestId(index + 1),
        senderThreadId: null,
        input: [{ type: "text", text, mentions: [] }],
        target: { kind: "thread-start" },
        execution,
      }),
    })),
  );
}

function setup(): Setup {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const { project: otherProject } = createProject(db, noopNotifier, {
    name: "other-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
  });

  const origin = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const middle = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
  });
  const head = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
  });
  const otherProjectThread = createThread(db, noopNotifier, {
    projectId: otherProject.id,
    providerId: "codex",
  });

  seedMessages(db, origin, ["origin one", "origin two"]);
  seedMessages(db, middle, ["middle one"]);
  seedMessages(db, head, ["head one"]);
  seedMessages(db, otherProjectThread, ["secret"]);

  setThreadSupersededBy(db, noopNotifier, {
    threadId: origin.id,
    supersededByThreadId: middle.id,
  });
  setThreadSupersededBy(db, noopNotifier, {
    threadId: middle.id,
    supersededByThreadId: head.id,
  });

  return { chain: [origin, middle, head], db, otherProjectThread };
}

function olderPage(
  cursor: { anchorId: string; anchorSeq: number },
  segmentLimit = 20,
): ThreadTimelinePageRequest {
  return { beforeCursor: cursor, kind: "older", segmentLimit };
}

function rowText(row: { kind: string; text?: string | null }): string | null {
  return row.text ?? null;
}

describe("lineage timeline continuation", () => {
  it("continues an exhausted thread into the thread it retired", () => {
    const { chain, db } = setup();
    const [origin, middle, head] = chain as [Thread, Thread, Thread];

    const toMiddle = buildLineageContinuationCursor(db, head);
    expect(toMiddle).not.toBeNull();

    const middlePage = buildLineageTimelinePage(db, {
      eventBudget: 5_000,
      includeNestedRows: false,
      includeProviderUnhandledOperations: false,
      maxInlineOutputChars: 10_000,
      page: resolveLineageTimelinePage(db, {
        page: olderPage(toMiddle!),
        thread: head,
      })!.page,
      planCommand: null,
      providerDisplayName: "Claude Code",
      requestedThreadMaxSeq: 1,
      summaryOnly: false,
      thread: middle,
    });

    // The predecessor's rows carry the PREDECESSOR's threadId, so the app can
    // tell them apart without any contract change.
    expect(middlePage.rows.map((row) => row.threadId)).toEqual([middle.id]);
    expect(middlePage.rows.map(rowText)).toEqual(["middle one"]);
    // `maxSeq` still names the thread the client asked for.
    expect(middlePage.maxSeq).toBe(1);
    // And the chain keeps going: middle retired origin.
    expect(middlePage.timelinePage.hasOlderRows).toBe(true);
    expect(middlePage.timelinePage.olderCursor?.anchorId).toContain(origin.id);
  });

  it("walks a three-thread chain to its origin and then stops", () => {
    const { chain, db } = setup();
    const [origin, middle, head] = chain as [Thread, Thread, Thread];

    let cursor = buildLineageContinuationCursor(db, head);
    const seenThreadIds: string[] = [];
    for (let step = 0; step < 5 && cursor !== null; step += 1) {
      const resolved = resolveLineageTimelinePage(db, {
        page: olderPage(cursor),
        thread: head,
      });
      expect(resolved).not.toBeNull();
      const page = buildLineageTimelinePage(db, {
        eventBudget: 5_000,
        includeNestedRows: false,
        includeProviderUnhandledOperations: false,
        maxInlineOutputChars: 10_000,
        page: resolved!.page,
        planCommand: null,
        providerDisplayName: undefined,
        requestedThreadMaxSeq: 1,
        summaryOnly: false,
        thread: resolved!.thread,
      });
      seenThreadIds.push(resolved!.thread.id);
      cursor = page.timelinePage.olderCursor;
    }

    // Every page after the head's own rows walked backward exactly once per
    // link, and the origin terminated the walk.
    expect(seenThreadIds).toEqual([middle.id, origin.id]);
    expect(cursor).toBeNull();
  });

  it("returns null for a cursor that belongs to the requested thread", () => {
    const { chain, db } = setup();
    const head = chain[2]!;
    expect(
      resolveLineageTimelinePage(db, {
        page: olderPage({ anchorId: "evt_something", anchorSeq: 3 }),
        thread: head,
      }),
    ).toBeNull();
    expect(
      resolveLineageTimelinePage(db, {
        page: { kind: "latest", segmentLimit: 20 },
        thread: head,
      }),
    ).toBeNull();
  });

  it("rejects a cursor naming a thread that is not a predecessor", () => {
    const { chain, db, otherProjectThread } = setup();
    const head = chain[2]!;

    // A forged cursor is the one place a timeline request can name a thread
    // other than its path parameter, so this is an authorization check.
    expect(() =>
      resolveLineageTimelinePage(db, {
        page: olderPage({
          anchorId: `${otherProjectThread.id}:lineage:`,
          anchorSeq: 1,
        }),
        thread: head,
      }),
    ).toThrow(/no longer available/);

    // Direction matters too: the head is not its own predecessor.
    expect(() =>
      resolveLineageTimelinePage(db, {
        page: olderPage({ anchorId: `${head.id}:lineage:`, anchorSeq: 1 }),
        thread: head,
      }),
    ).toThrow(/no longer available/);
  });

  it("offers no continuation when nothing was retired into this thread", () => {
    const { chain, db, otherProjectThread } = setup();
    expect(buildLineageContinuationCursor(db, chain[0]!)).toBeNull();
    expect(buildLineageContinuationCursor(db, otherProjectThread)).toBeNull();
  });

  it("skips an empty intermediate predecessor and continues into origin history", () => {
    const { chain, db } = setup();
    const [origin, middle, head] = chain as [Thread, Thread, Thread];
    db.$client
      .prepare("DELETE FROM events WHERE thread_id = ?")
      .run(middle.id);

    const cursor = buildLineageContinuationCursor(db, head);
    expect(cursor).not.toBeNull();
    expect(cursor?.anchorId).toContain(origin.id);

    const resolved = resolveLineageTimelinePage(db, {
      page: olderPage(cursor!),
      thread: head,
    });
    expect(resolved?.thread.id).toBe(origin.id);
  });

  it("terminates on a self-referential lineage edge", () => {
    const { chain, db } = setup();
    const head = chain[2]!;
    // Written straight to the column: setThreadLineage refuses this, but the
    // walk must not trust that a backfill or another primitive did.
    setThreadSupersededBy(db, noopNotifier, {
      threadId: head.id,
      supersededByThreadId: head.id,
    });
    expect(() =>
      resolveLineageTimelinePage(db, {
        page: olderPage({ anchorId: "thr_missing:lineage:", anchorSeq: 1 }),
        thread: head,
      }),
    ).toThrow(/no longer available/);
  });
});
