import { archiveThread, getThread, markThreadDeleted } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  findLineagePredecessor,
  listLineage,
  resolveLineageHead,
  setThreadLineage,
} from "../../src/services/threads/thread-lineage.js";
import {
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedProject(harness: TestAppHarness, value: number) {
  const host = seedHost(harness.deps, { id: `host-lineage-${value}` });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/lineage-${value}`,
  });
  return project;
}

function seedChain(harness: TestAppHarness, value: number, length: number) {
  const project = seedProject(harness, value);
  const threads = Array.from({ length }, (_, index) =>
    seedThread(harness.deps, {
      projectId: project.id,
      title: `link-${index}`,
    }),
  );
  for (let index = 0; index + 1 < threads.length; index += 1) {
    setThreadLineage(harness.deps, {
      thread: threads[index]!,
      supersededByThreadId: threads[index + 1]!.id,
    });
  }
  return { project, threads };
}

describe("resolveLineageHead", () => {
  it("walks a chain to the live head from any link", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 1, 3);
      const head = threads[2]!;

      for (const link of threads) {
        expect(resolveLineageHead(harness.db, link.id)?.thread.id).toBe(
          head.id,
        );
      }
      expect(resolveLineageHead(harness.db, threads[0]!.id)?.hops).toBe(2);
      expect(resolveLineageHead(harness.db, head.id)).toMatchObject({
        hops: 0,
        truncated: false,
      });
    });
  });

  it("returns null for an unknown or deleted thread", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 2, 2);
      expect(resolveLineageHead(harness.db, "thr_missing")).toBeNull();

      markThreadDeleted(harness.db, harness.hub, { threadId: threads[0]!.id });
      expect(resolveLineageHead(harness.db, threads[0]!.id)).toBeNull();
    });
  });

  it("stops at the last live link when the successor was deleted", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 3, 2);
      markThreadDeleted(harness.db, harness.hub, { threadId: threads[1]!.id });

      // The retired thread is the only readable target left, so it is what a
      // deliverer gets — flagged so the caller can log rather than guess.
      expect(resolveLineageHead(harness.db, threads[0]!.id)).toMatchObject({
        thread: expect.objectContaining({ id: threads[0]!.id }),
        truncated: true,
      });
    });
  });

  it("resolves through an archived link without un-archiving it", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 4, 2);
      archiveThread(harness.db, harness.hub, threads[0]!.id);

      // Charter D4: the three dispositions are independent. Resolving lineage
      // must never repair an archive — that is the `ensureThreadListed`
      // behaviour this function exists to make unnecessary.
      expect(resolveLineageHead(harness.db, threads[0]!.id)?.thread.id).toBe(
        threads[1]!.id,
      );
      expect(getThread(harness.db, threads[0]!.id)?.archivedAt).not.toBeNull();
      expect(getThread(harness.db, threads[1]!.id)?.archivedAt).toBeNull();
      expect(getThread(harness.db, threads[1]!.id)?.visibility).toBe("visible");
    });
  });
});

describe("setThreadLineage", () => {
  it("refuses a self edge, a cross-project edge and a cycle", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 5, 2);
      const otherProject = seedProject(harness, 6);
      const foreign = seedThread(harness.deps, {
        projectId: otherProject.id,
      });

      expect(() =>
        setThreadLineage(harness.deps, {
          thread: threads[0]!,
          supersededByThreadId: threads[0]!.id,
        }),
      ).toThrow(/cannot supersede itself/);

      expect(() =>
        setThreadLineage(harness.deps, {
          thread: threads[0]!,
          supersededByThreadId: foreign.id,
        }),
      ).toThrow(/cross projects/);

      // threads[0] -> threads[1] already exists; the reverse would close a loop.
      expect(() =>
        setThreadLineage(harness.deps, {
          thread: threads[1]!,
          supersededByThreadId: threads[0]!.id,
        }),
      ).toThrow(/cycle/);

      expect(() =>
        setThreadLineage(harness.deps, {
          thread: threads[0]!,
          supersededByThreadId: "thr_missing",
        }),
      ).toThrow(/not found/);
    });
  });

  it("refuses a second predecessor onto the same successor", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 14, 2);
      const extra = seedThread(harness.deps, {
        projectId: threads[0]!.projectId,
        title: "fan-in",
      });

      expect(() =>
        setThreadLineage(harness.deps, {
          thread: extra,
          supersededByThreadId: threads[1]!.id,
        }),
      ).toThrow(/only one predecessor/);

      expect(getThread(harness.db, extra.id)?.supersededByThreadId).toBeNull();
      expect(findLineagePredecessor(harness.db, threads[1]!)?.id).toBe(
        threads[0]!.id,
      );
    });
  });

  it("un-retires a thread when the edge is cleared", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 7, 2);
      expect(
        getThread(harness.db, threads[0]!.id)?.supersededByThreadId,
      ).toBe(threads[1]!.id);

      setThreadLineage(harness.deps, {
        thread: threads[0]!,
        supersededByThreadId: null,
      });

      const restored = getThread(harness.db, threads[0]!.id);
      expect(restored?.supersededByThreadId).toBeNull();
      // Un-retiring touches nothing else: it is not an un-archive and not an
      // un-hide.
      expect(restored?.archivedAt).toBeNull();
      expect(restored?.visibility).toBe("visible");
      expect(resolveLineageHead(harness.db, threads[0]!.id)?.hops).toBe(0);
    });
  });
});

describe("listLineage / findLineagePredecessor", () => {
  it("returns the whole chain oldest first from any link", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 8, 3);
      const expected = threads.map((thread) => thread.id);

      for (const link of threads) {
        expect(listLineage(harness.db, link.id).map((row) => row.id)).toEqual(
          expected,
        );
      }
    });
  });

  it("does not treat a same-id thread in another project as a predecessor", async () => {
    await withTestHarness(async (harness) => {
      const { threads } = seedChain(harness, 9, 2);
      expect(
        findLineagePredecessor(harness.db, threads[1]!)?.id,
      ).toBe(threads[0]!.id);
      // The predecessor lookup is the authorization check the timeline
      // continuation relies on, so it must be project-scoped.
      expect(
        findLineagePredecessor(harness.db, {
          id: threads[1]!.id,
          projectId: "prj_other",
        }),
      ).toBeNull();
    });
  });
});
