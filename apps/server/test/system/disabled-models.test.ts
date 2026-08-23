import { setDisabledModels } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  applyDisabledModels,
  resolveSystemExecutionOptions,
} from "../../src/services/system/execution-options.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { registerProviderHostRpcResponder } from "../helpers/host-rpc.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("applyDisabledModels", () => {
  it("demotes a disabled model into selectedOnlyModels instead of removing it", () => {
    const kept = availableModelFixture({ model: "keep-me", isDefault: true });
    const disabled = availableModelFixture({ model: "hide-me" });

    const result = applyDisabledModels({
      disabledModels: [{ providerId: "pi", model: "hide-me" }],
      models: [kept, disabled],
      providerId: "pi",
      selectedOnlyModels: [],
    });

    // Demotion, not deletion: a thread already pinned to "hide-me" must still
    // resolve it, and the picker must not treat it as retired.
    expect(result.models.map((model) => model.model)).toEqual(["keep-me"]);
    expect(result.selectedOnlyModels.map((model) => model.model)).toEqual([
      "hide-me",
    ]);
  });

  it("only matches within the same provider", () => {
    const model = availableModelFixture({ model: "shared-name" });

    const result = applyDisabledModels({
      disabledModels: [{ providerId: "codex", model: "shared-name" }],
      models: [model],
      providerId: "pi",
      selectedOnlyModels: [],
    });

    expect(result.models).toEqual([model]);
    expect(result.selectedOnlyModels).toEqual([]);
  });
});

describe("resolveSystemExecutionOptions with disabled models", () => {
  it("hides disabled models from the catalog every consumer reads", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-disabled-models",
      });
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelsByProviderId: {
          "claude-code": {
            models: [
              availableModelFixture({ model: "wanted", isDefault: false }),
              availableModelFixture({ model: "unwanted", isDefault: true }),
            ],
            selectedOnlyModels: [],
          },
        },
      });

      setDisabledModels(harness.db, [
        { providerId: "claude-code", model: "unwanted" },
      ]);

      const response = await resolveSystemExecutionOptions(harness.deps, {
        hostId: host.id,
        providerId: "claude-code",
      });

      expect(response.models.map((model) => model.model)).toEqual(["wanted"]);
      expect(response.selectedOnlyModels.map((model) => model.model)).toEqual([
        "unwanted",
      ]);
    });
  });
});
