import type {
  PromptInput,
  ThreadTurnInitiator,
  TurnRequestTarget,
} from "@bb/domain";
import type {
  TurnPreflightContext,
  TurnPreflightTrigger,
} from "@get-bb/plugin-sdk";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  requestPluginTurnPreflightApproval,
  runPluginTurnPreflight,
} from "../plugins/plugin-agent-contributions.js";

export const TURN_PREFLIGHT_BUDGET_MS = 2_000;

export interface TurnDispatchIntent {
  requestId: TurnPreflightContext["requestId"];
  initiator: ThreadTurnInitiator;
  senderThreadId: string | null;
  trigger: TurnPreflightTrigger;
  target: TurnRequestTarget;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
}

export interface TurnPreflightOutcome {
  input: PromptInput[];
  inputGroups: PromptInput[][] | undefined;
  bindingOverride: { providerId?: string; model?: string } | null;
}

export class TurnPreflightRejectedError extends Error {
  readonly pluginId: string;
  readonly code: string;

  constructor(args: { pluginId: string; code: string; message: string }) {
    super(args.message);
    this.name = "TurnPreflightRejectedError";
    this.pluginId = args.pluginId;
    this.code = args.code;
  }
}

export function toTurnPreflightApiError(error: unknown): ApiError | null {
  if (!(error instanceof TurnPreflightRejectedError)) return null;
  return new ApiError(422, "turn_rejected", error.message, {
    details: { pluginId: error.pluginId, code: error.code },
  });
}

function appendContextItems(args: {
  input: PromptInput[];
  inputGroups: PromptInput[][] | undefined;
  contextItems: PromptInput[];
}): { input: PromptInput[]; inputGroups: PromptInput[][] | undefined } {
  const input = [...args.input, ...args.contextItems];
  if (args.inputGroups === undefined || args.inputGroups.length === 0) {
    return { input, inputGroups: args.inputGroups };
  }
  const lastGroup = args.inputGroups[args.inputGroups.length - 1]!;
  return {
    input,
    inputGroups: [
      ...args.inputGroups.slice(0, -1),
      [...lastGroup, ...args.contextItems],
    ],
  };
}

export async function runTurnPreflight(
  deps: LoggedWorkSessionDeps,
  args: {
    threadId: string;
    projectId: string;
    environmentId: string;
    providerId: string;
    model: string;
    intent: TurnDispatchIntent;
    budgetMs?: number;
  },
): Promise<TurnPreflightOutcome> {
  const context: TurnPreflightContext = {
    threadId: args.threadId,
    projectId: args.projectId,
    environmentId: args.environmentId,
    requestId: args.intent.requestId,
    initiator: args.intent.initiator,
    senderThreadId: args.intent.senderThreadId,
    trigger: args.intent.trigger,
    target: args.intent.target,
    input: args.intent.input,
    inputGroups: args.intent.inputGroups ?? null,
    binding: { providerId: args.providerId, model: args.model },
  };
  const result = await runPluginTurnPreflight({
    context,
    deadlineAt: Date.now() + (args.budgetMs ?? TURN_PREFLIGHT_BUDGET_MS),
  });
  let input = [...args.intent.input];
  let inputGroups = args.intent.inputGroups?.map((group) => [...group]);
  let replaceInputClaimed = false;
  let bindingOverride: TurnPreflightOutcome["bindingOverride"] = null;

  for (const { pluginId, decision } of result.decisions) {
    if (decision.kind === "reject") {
      throw new TurnPreflightRejectedError({
        pluginId,
        code: decision.code,
        message: decision.message,
      });
    }
    if (decision.kind === "require-approval") {
      const approval = await requestPluginTurnPreflightApproval({
        pluginId,
        threadId: args.threadId,
        rendererId: decision.rendererId,
        title: decision.title,
        payload: decision.payload,
        timeoutMs: decision.timeoutMs,
      });
      if (approval.outcome !== "submitted") {
        throw new TurnPreflightRejectedError({
          pluginId,
          code: "approval-cancelled",
          message: `Turn approval was not granted: ${approval.reason}`,
        });
      }
      continue;
    }
    if (decision.kind !== "admit-with") continue;
    if (decision.tools !== undefined || decision.skills !== undefined) {
      deps.logger.warn(
        { pluginId, threadId: args.threadId },
        "Plugin turn preflight tool/skill selection was ignored; spawn-pinned configuration wins",
      );
    }
    if (decision.replaceInput !== undefined) {
      if (args.intent.trigger === "user") {
        deps.logger.warn(
          { pluginId, threadId: args.threadId },
          "Plugin turn preflight replaceInput was refused for a user-triggered turn",
        );
      } else if (replaceInputClaimed) {
        deps.logger.warn(
          { pluginId, threadId: args.threadId },
          "Plugin turn preflight replaceInput claim was ignored because another plugin already claimed it",
        );
      } else {
        replaceInputClaimed = true;
        input = [...decision.replaceInput];
        inputGroups = undefined;
      }
    }
    if (
      decision.contextItems !== undefined &&
      decision.contextItems.length > 0
    ) {
      ({ input, inputGroups } = appendContextItems({
        input,
        inputGroups,
        contextItems: decision.contextItems,
      }));
    }
    if (decision.binding !== undefined) {
      const requestedProviderId = decision.binding.providerId;
      const providerId =
        requestedProviderId !== undefined &&
        deps.providerRegistry.get(requestedProviderId) !== undefined
          ? requestedProviderId
          : undefined;
      if (requestedProviderId !== undefined && providerId === undefined) {
        deps.logger.warn(
          {
            pluginId,
            providerId: requestedProviderId,
            threadId: args.threadId,
          },
          "Plugin turn preflight requested an unknown provider; ignoring the provider override",
        );
      }
      const nextOverride: NonNullable<TurnPreflightOutcome["bindingOverride"]> =
        {
          ...(bindingOverride ?? {}),
          ...(providerId !== undefined ? { providerId } : {}),
          ...(decision.binding.model !== undefined
            ? { model: decision.binding.model }
            : {}),
        };
      bindingOverride =
        Object.keys(nextOverride).length === 0 ? null : nextOverride;
    }
  }

  return { input, inputGroups, bindingOverride };
}
