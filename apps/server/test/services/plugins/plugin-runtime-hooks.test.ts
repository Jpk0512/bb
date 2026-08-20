import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import type { BbSdk } from "@bb/sdk";
import { createPluginApi } from "../../../src/services/plugins/plugin-api.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { testLogger } from "../../helpers/test-app.js";

describe("plugin runtime hooks", () => {
  let db: DbConnection;
  let service: PluginService;
  let workDir: string;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-runtime-hooks-"));
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
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__runtimeHookEvents;
  });

  it("orders preflight decisions and dispatches filtered durable observers", async () => {
    const root = join(workDir, "bb-plugin-runtime-hooks");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-runtime-hooks",
        version: "0.1.0",
        bb: {
          name: "Runtime hooks",
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
        g.__runtimeHookEvents = [];
        bb.runtime.onTurnPreflight(() => ({ kind: "admit" }));
        bb.runtime.onTurnPreflight(() => ({ kind: "reject", code: "policy", message: "Blocked by policy" }));
        bb.runtime.onProviderEvent((event: any) => g.__runtimeHookEvents.push(["provider", event.sequence]), { eventTypes: ["provider/warning"] });
        bb.runtime.onTurnSettled((signal: any) => g.__runtimeHookEvents.push(["settled", signal.outcome]));
        bb.runtime.onBindingLifecycle((signal: any) => g.__runtimeHookEvents.push(["binding", signal.phase]));
      }`,
    );
    await service.installPath(root);

    await expect(
      service.runTurnPreflight({
        deadlineAt: Date.now() + 1_000,
        context: {
          threadId: "thread-1",
          projectId: "project-1",
          environmentId: "environment-1",
          requestId: "creq_abcdefghjk",
          initiator: "user",
          senderThreadId: null,
          trigger: "user",
          target: { kind: "new-turn" },
          input: [],
          inputGroups: null,
          binding: { providerId: "codex", model: "gpt-test" },
        },
      }),
    ).resolves.toEqual({
      decisions: [
        { pluginId: "runtime-hooks", decision: { kind: "admit" } },
        {
          pluginId: "runtime-hooks",
          decision: {
            kind: "reject",
            code: "policy",
            message: "Blocked by policy",
          },
        },
      ],
      timedOut: false,
    });

    service.dispatchProviderEvents([
      {
        threadId: "thread-1",
        environmentId: "environment-1",
        providerThreadId: "provider-1",
        sequence: 7,
        turnId: null,
        scope: { kind: "thread" },
        event: {
          type: "provider/warning",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          category: "general",
          scope: { kind: "thread" },
        },
      },
    ]);
    service.dispatchTurnSettled({
      threadId: "thread-1",
      turnId: "turn-1",
      providerThreadId: "provider-1",
      providerId: "codex",
      requestId: null,
      outcome: "completed",
      error: null,
      providerCheckpointId: null,
      startedAt: null,
      settledAt: 1,
      turn: null,
    });
    // A late terminal event must not produce a second settlement for the same
    // turn after an earlier command-result settlement.
    service.dispatchTurnSettled({
      threadId: "thread-1",
      turnId: "turn-1",
      providerThreadId: "provider-1",
      providerId: "codex",
      requestId: null,
      outcome: "failed",
      error: "late terminal event",
      providerCheckpointId: null,
      startedAt: null,
      settledAt: 2,
      turn: null,
    });
    service.dispatchBindingLifecycle({
      threadId: "thread-1",
      bindingId: "thread-1:codex:provider-1",
      providerId: "codex",
      providerThreadId: "provider-1",
      phase: "start",
      detail: null,
    });

    await vi.waitFor(() =>
      expect(
        (globalThis as Record<string, unknown>).__runtimeHookEvents,
      ).toEqual([
        ["provider", 7],
        ["settled", "completed"],
        ["binding", "start"],
      ]),
    );
  });

  it("owns SDK subscriptions until the plugin is disposed", async () => {
    const unsubscribe = vi.fn();
    const sdk = {
      subscribe: vi.fn(() => unsubscribe),
    } as unknown as BbSdk;
    const handle = createPluginApi({
      pluginId: "runtime-hooks",
      logger: testLogger,
      db,
      dataDir: join(workDir, "data"),
      getSdk: () => sdk,
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      publishSignal: () => {},
      replaceDeclaredRealtimeChannels: () => {},
      reportNeedsConfiguration: () => {},
      isAgentToolNameTaken: () => undefined,
      reportAgentToolProblem: () => {},
      requestInteraction: async () => ({
        outcome: "cancelled",
        reason: "plugin-disposed",
      }),
      ensureSharedPortTunnel: async () => {
        throw new Error("not used by this test");
      },
      validateSharedPortDeclaration: (_hostId, ports) => ports,
      declareSharedPorts: () => {},
      replaceDeclaredSharedPorts: () => {},
      registerProvider: () => ({ dispose: () => {} }),
      isProviderIdTaken: () => false,
      assertProviderRegistrable: () => {},
    });

    handle.api.sdk.subscribe({ event: "thread:changed", callback: () => {} });
    for (const hook of handle.disposeHooks) await hook();
    // A handler that races with disposal must not leave a new live
    // subscription behind after the aggregate disposer has run.
    handle.api.sdk.subscribe({ event: "thread:changed", callback: () => {} });

    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
