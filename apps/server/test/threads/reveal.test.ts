import { archiveThread, getThread, markThreadDeleted } from "@bb/db";
import { threadRevealResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function postReveal(
  harness: TestAppHarness,
  threadId: string,
  body: unknown,
): Promise<Response> {
  return harness.app.request(`/api/v1/threads/${threadId}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("thread reveal", () => {
  for (const hidden of [false, true]) {
    for (const archived of [false, true]) {
      it(`reports hidden=${hidden} archived=${archived} restoration accurately`, async () => {
        await withTestHarness(async (harness) => {
          const { host } = seedHostSession(harness.deps, {
            id: `host-reveal-${hidden}-${archived}`,
          });
          const { project } = seedProjectWithSource(harness.deps, {
            hostId: host.id,
            path: `/tmp/reveal-${hidden}-${archived}`,
          });
          const thread = seedThread(harness.deps, {
            projectId: project.id,
            visibility: hidden ? "hidden" : "visible",
          });
          if (archived) archiveThread(harness.db, harness.deps.hub, thread.id);

          const response = await postReveal(harness, thread.id, {
            unhide: true,
            unarchive: true,
          });
          expect(response.status).toBe(200);
          expect(
            threadRevealResponseSchema.parse(await readJson(response)),
          ).toMatchObject({
            restored: { unhidden: hidden, unarchived: archived },
            thread: { visibility: "visible", archivedAt: null },
          });

          const second = await postReveal(harness, thread.id, {
            unhide: true,
            unarchive: true,
          });
          expect(
            threadRevealResponseSchema.parse(await readJson(second)).restored,
          ).toEqual({ unhidden: false, unarchived: false });
        });
      });
    }
  }

  it("does not restore either disposition when options are omitted", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reveal-explicit",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/reveal-explicit",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        visibility: "hidden",
      });
      archiveThread(harness.db, harness.deps.hub, thread.id);

      const response = await postReveal(harness, thread.id, {});
      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        visibility: "hidden",
        archivedAt: expect.any(Number),
      });
    });
  });

  it("returns 404 only for a deleted or unknown thread", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reveal-deleted",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/reveal-deleted",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      markThreadDeleted(harness.db, harness.deps.hub, {
        threadId: thread.id,
      });

      expect((await postReveal(harness, thread.id, {})).status).toBe(404);
      expect((await postReveal(harness, "thr_missing", {})).status).toBe(404);
    });
  });
});
