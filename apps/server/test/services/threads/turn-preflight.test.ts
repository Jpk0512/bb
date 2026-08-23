import { afterEach, describe, expect, it } from "vitest";
import { createConnection, migrate, setDisabledModels } from "@bb/db";
import type { LoggedWorkSessionDeps } from "../../../src/types.js";
import { setPluginAgentContributions } from "../../../src/services/plugins/plugin-agent-contributions.js";
import {
  TurnPreflightRejectedError,
  runTurnPreflight,
} from "../../../src/services/threads/turn-preflight.js";
import { testLogger } from "../../helpers/test-app.js";

const prompt = (text: string) => ({
  type: "text" as const,
  text,
  mentions: [],
});

// Preflight consults the model curation list before honoring a plugin's
// binding override, so this needs a real database rather than a stub.
const db = createConnection(":memory:");
migrate(db);

const deps = {
  db,
  logger: testLogger,
  providerRegistry: new Map([["codex", {}]]),
} as unknown as LoggedWorkSessionDeps;

function args(trigger: "user" | "auto-dispatch" = "auto-dispatch") {
  return {
    threadId: "thread-1",
    projectId: "project-1",
    environmentId: "environment-1",
    providerId: "codex",
    model: "gpt-test",
    intent: {
      requestId: "creq_abcdefghjk",
      initiator: "user" as const,
      senderThreadId: null,
      trigger,
      target: { kind: "new-turn" as const },
      input: [prompt("original")],
      inputGroups: [[prompt("original")]],
    },
  };
}

afterEach(() => {
  setPluginAgentContributions(undefined);
  setDisabledModels(db, []);
});

describe("runTurnPreflight", () => {
  it("keeps the first replacement, appends context in order, and ignores an unknown provider", async () => {
    setPluginAgentContributions({
      async runTurnPreflight() {
        return {
          timedOut: false,
          decisions: [
            {
              pluginId: "alpha",
              decision: {
                kind: "admit-with",
                replaceInput: [prompt("replacement")],
                contextItems: [prompt("alpha context")],
                binding: { providerId: "codex", model: "gpt-override" },
              },
            },
            {
              pluginId: "beta",
              decision: {
                kind: "admit-with",
                replaceInput: [prompt("discarded replacement")],
                contextItems: [prompt("beta context")],
                binding: { providerId: "unknown-provider" },
              },
            },
          ],
        };
      },
    });

    await expect(runTurnPreflight(deps, args())).resolves.toEqual({
      input: [
        prompt("replacement"),
        prompt("alpha context"),
        prompt("beta context"),
      ],
      inputGroups: undefined,
      bindingOverride: { providerId: "codex", model: "gpt-override" },
    });
  });

  it("ignores a plugin binding override that names a disabled model", async () => {
    setDisabledModels(db, [{ providerId: "codex", model: "gpt-banned" }]);
    setPluginAgentContributions({
      async runTurnPreflight() {
        return {
          timedOut: false,
          decisions: [
            {
              pluginId: "alpha",
              decision: {
                kind: "admit-with",
                binding: { providerId: "codex", model: "gpt-banned" },
              },
            },
          ],
        };
      },
    });

    const outcome = await runTurnPreflight(deps, args());

    // The provider override still applies; only the excluded model is dropped,
    // so a plugin cannot route a turn onto a model the user curated out.
    expect(outcome.bindingOverride).toEqual({ providerId: "codex" });
  });

  it("refuses user-input replacement but records an explicit rejection", async () => {
    setPluginAgentContributions({
      async runTurnPreflight() {
        return {
          timedOut: false,
          decisions: [
            {
              pluginId: "alpha",
              decision: {
                kind: "admit-with",
                replaceInput: [prompt("forbidden")],
                contextItems: [prompt("allowed context")],
              },
            },
            {
              pluginId: "beta",
              decision: {
                kind: "reject",
                code: "policy",
                message: "This turn needs approval.",
              },
            },
          ],
        };
      },
    });

    await expect(runTurnPreflight(deps, args("user"))).rejects.toEqual(
      new TurnPreflightRejectedError({
        pluginId: "beta",
        code: "policy",
        message: "This turn needs approval.",
      }),
    );
  });
});
