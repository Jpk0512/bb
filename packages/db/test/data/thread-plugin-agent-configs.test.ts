import { describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  listThreadPluginAgentConfigRows,
  migrate,
  noopNotifier,
  upsertHost,
} from "../../src/index.js";

function setup() {
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
  return { db, project };
}

describe("thread plugin agent configurations", () => {
  it("persists a worker pin atomically with its thread", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const worker = createThread(db, noopNotifier, {
      childKind: "dispatch:worker",
      originPluginId: "dispatch",
      parentThreadId: parent.id,
      pluginAgentConfiguration: {
        instructions: "Return a concise result.",
        pluginId: "dispatch",
        skillsJson: "[]",
        toolsJson: "[]",
      },
      projectId: project.id,
      providerId: "codex",
      visibility: "hidden",
    });

    expect(listThreadPluginAgentConfigRows(db, worker.id)).toEqual([
      expect.objectContaining({
        instructions: "Return a concise result.",
        pluginId: "dispatch",
        skillsJson: "[]",
        threadId: worker.id,
        toolsJson: "[]",
      }),
    ]);
  });
});
