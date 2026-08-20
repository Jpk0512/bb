import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection, migrate } from "@bb/db";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import {
  createPluginService,
  type PluginService,
} from "../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../src/services/system/telemetry.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness, testLogger } from "../helpers/test-app.js";

describe("internal runtime-hook delivery", () => {
  let service: PluginService | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    setPluginAgentContributions(undefined);
    await service?.stop();
    if (workDir) await rm(workDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__internalRuntimeHookEvents;
  });

  it("delivers normalized events and binding transitions only after ingestion", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-internal-runtime-hooks-"));
    service = createPluginService({
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger: testLogger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2_000,
    });
    const root = join(workDir, "bb-plugin-internal-runtime-hooks");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-internal-runtime-hooks",
        version: "0.1.0",
        bb: {
          name: "Internal runtime hooks",
          description: "Test fixture",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(root, "server.ts"),
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        g.__internalRuntimeHookEvents = [];
        bb.runtime.onProviderEvent((event: any) => g.__internalRuntimeHookEvents.push(["event", event.sequence, event.event.type]));
        bb.runtime.onBindingLifecycle((signal: any) => g.__internalRuntimeHookEvents.push(["binding", signal.phase, signal.bindingId]));
      }`,
    );
    await service.installPath(root);

    const harness = await createTestAppHarness();
    try {
      // The app harness resets process-global plugin bridges while it builds
      // its isolated server, so attach the fixture after that setup.
      setPluginAgentContributions(service);
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "thread/identity",
                threadId: thread.id,
                providerThreadId: "provider-1",
                scope: { kind: "thread" },
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "provider/warning",
                threadId: thread.id,
                providerThreadId: "provider-1",
                category: "general",
                scope: { kind: "thread" },
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() =>
        expect(
          (globalThis as Record<string, unknown>).__internalRuntimeHookEvents,
        ).toEqual([
          ["event", 1, "thread/identity"],
          ["event", 2, "provider/warning"],
          ["binding", "start", `${thread.id}:codex:provider-1`],
        ]),
      );

      const resumeResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents([
              {
                threadId: thread.id,
                event: {
                  type: "thread/identity",
                  threadId: thread.id,
                  providerThreadId: "provider-2",
                  scope: { kind: "thread" },
                },
              },
            ]),
          }),
        },
      );
      expect(resumeResponse.status).toBe(200);
      await vi.waitFor(() =>
        expect(
          (globalThis as Record<string, unknown>).__internalRuntimeHookEvents,
        ).toEqual([
          ["event", 1, "thread/identity"],
          ["event", 2, "provider/warning"],
          ["binding", "start", `${thread.id}:codex:provider-1`],
          ["event", 3, "thread/identity"],
          ["binding", "resume", `${thread.id}:codex:provider-2`],
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });
});
