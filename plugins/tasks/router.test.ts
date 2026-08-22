import { describe, expect, it } from "vitest";
import { routeTask, type RouterCandidate } from "./router.js";
import type { Preset } from "./shared/contract.js";

function candidate(id: string, activeThreads: number): RouterCandidate {
  const preset: Preset = {
    id,
    name: id,
    providerId: "codex",
    modelId: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "accept-edits",
    environmentKind: "project-default",
    baseBranch: null,
    machineId: null,
    instructions: "",
    builtin: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return { preset, activeThreads };
}

describe("Mission Control router v1", () => {
  it("selects the least-loaded preset and persists explainable reasons", () => {
    const decision = routeTask({ priority: "high" }, [
      candidate("01J00000000000000000000002", 1),
      candidate("01J00000000000000000000001", 0),
    ]);
    expect(decision.presetId).toBe("01J00000000000000000000001");
    expect(decision.reasons).toContain("router-v1:deterministic-scorecard");
    expect(decision.reasons).toContain("active-threads:0");
    expect(decision.scorecard).toEqual({
      "01J00000000000000000000001": 1,
      "01J00000000000000000000002": 0,
    });
  });

  it("uses the preset id as a stable tie-breaker", () => {
    expect(
      routeTask({ priority: "none" }, [
        candidate("01J00000000000000000000002", 0),
        candidate("01J00000000000000000000001", 0),
      ]).presetId,
    ).toBe("01J00000000000000000000001");
  });

  it("explains why no route was possible", () => {
    expect(routeTask({ priority: "urgent" }, [])).toEqual({
      presetId: null,
      reasons: ["router-v1:no-eligible-presets"],
      scorecard: {},
    });
  });
});
