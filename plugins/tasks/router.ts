import type { Preset, Task } from "./shared/contract.js";

/** The inputs used by the first, explainable Mission Control router. */
export interface RouterCandidate {
  preset: Preset;
  /** Number of currently attached working threads for this preset. */
  activeThreads: number;
}

export interface RoutingDecision {
  presetId: string | null;
  reasons: string[];
  scorecard: Record<string, number>;
}

/**
 * Deterministic Router v1. This intentionally has no model or network call:
 * identical task/candidate inputs produce the same selection and reasons.
 * Lower load wins, then a stable preset identity breaks ties.
 */
export function routeTask(
  task: Pick<Task, "priority">,
  candidates: readonly RouterCandidate[],
): RoutingDecision {
  if (candidates.length === 0) {
    return {
      presetId: null,
      reasons: ["router-v1:no-eligible-presets"],
      scorecard: {},
    };
  }

  const priorityBoost =
    task.priority === "urgent" ? 2 : task.priority === "high" ? 1 : 0;
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: priorityBoost - candidate.activeThreads,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.preset.id.localeCompare(right.candidate.preset.id),
    );
  const winner = ranked[0]!;
  return {
    presetId: winner.candidate.preset.id,
    reasons: [
      "router-v1:deterministic-scorecard",
      `priority-boost:${priorityBoost}`,
      `active-threads:${winner.candidate.activeThreads}`,
      "tie-break:preset-id",
    ],
    scorecard: Object.fromEntries(
      ranked.map(({ candidate, score }) => [candidate.preset.id, score]),
    ),
  };
}
