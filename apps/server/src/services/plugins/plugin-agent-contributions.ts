import type { ToolCallResponse } from "@bb/domain";
import type {
  BindingLifecycleSignal,
  PluginInteractionResult,
  ProviderEventObservation,
  TurnPreflightContext,
  TurnSettledSignal,
} from "@get-bb/plugin-sdk";
import type {
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginAgentToolRecord,
} from "./plugin-api.js";
import type {
  PluginAgentToolContribution,
  PluginMentionResolveResult,
  PluginService,
  PluginSkillRootContribution,
} from "./plugin-service.js";

/**
 * Module-level bridge from thread runtime-config assembly to the plugin
 * service (design §4.4), mirroring plugin-thread-events.ts: the runtime
 * config helpers receive narrow `{ db, hub, config, logger }` deps assembled
 * long before the plugin service exists, so createApp registers the live
 * service here instead of threading it through every deps object. Unset
 * (tests that never build an app) both calls are cheap no-ops.
 */
type PluginAgentContributions = Partial<
  Pick<
    PluginService,
    | "listSkillRootContributions"
    | "listAgentTools"
    | "listInstructionContributions"
    | "findAgentTool"
    | "invokeAgentTool"
    | "resolveMention"
    | "resolveAgentConfiguration"
    | "runTurnPreflight"
    | "requestTurnPreflightApproval"
    | "dispatchProviderEvents"
    | "dispatchTurnSettled"
    | "dispatchBindingLifecycle"
  >
>;

let contributions: PluginAgentContributions | undefined;

export async function runPluginTurnPreflight(args: {
  context: TurnPreflightContext;
  deadlineAt: number;
}) {
  const run = contributions?.runTurnPreflight;
  return run
    ? await run(args)
    : {
        decisions: [],
        timedOut: false,
      };
}

export function requestPluginTurnPreflightApproval(args: {
  pluginId: string;
  threadId: string;
  rendererId: string;
  title: string;
  payload: import("@bb/domain").JsonValue;
  timeoutMs: number;
}): Promise<PluginInteractionResult> {
  const request = contributions?.requestTurnPreflightApproval;
  if (!request) {
    return Promise.resolve({
      outcome: "cancelled",
      reason: "plugin-disposed",
    });
  }
  return request(args);
}

export function dispatchPluginProviderEvents(
  observations: ProviderEventObservation[],
): void {
  contributions?.dispatchProviderEvents?.(observations);
}

export function dispatchPluginTurnSettled(signal: TurnSettledSignal): void {
  contributions?.dispatchTurnSettled?.(signal);
}

export function dispatchPluginBindingLifecycle(
  signal: BindingLifecycleSignal,
): void {
  contributions?.dispatchBindingLifecycle?.(signal);
}

export function setPluginAgentContributions(
  next: PluginAgentContributions | undefined,
): void {
  contributions = next;
}

/** Skills roots contributed by running plugins (the "plugin" skill tier). */
export function getPluginSkillRootContributions(): PluginSkillRootContribution[] {
  return contributions?.listSkillRootContributions?.() ?? [];
}

/** Native tools from bb.agents.registerTool, resolved live per session start. */
export function listPluginAgentTools(): PluginAgentToolContribution[] {
  return contributions?.listAgentTools?.() ?? [];
}

export async function resolvePluginAgentConfiguration(args: {
  context: PluginAgentConfigurationContext;
  skillIdsByPlugin: ReadonlyMap<string, readonly string[]>;
}) {
  const active = contributions;
  if (!active?.resolveAgentConfiguration) {
    return {
      tools: active?.listAgentTools?.() ?? [],
      selectedSkillIdsByPlugin: new Map<string, ReadonlySet<string>>(),
      dynamicInstructions: [] as Array<{ pluginId: string; text: string }>,
    };
  }
  return active.resolveAgentConfiguration(args);
}

/**
 * Dynamic instruction providers from bb.agents.contributeInstructions,
 * resolved live per session start / turn submit.
 */
export function listPluginInstructionContributions(): Array<{
  pluginId: string;
  provider: (ctx: { threadId: string; projectId: string }) => string | null;
}> {
  return contributions?.listInstructionContributions?.() ?? [];
}

/** Resolve a native plugin tool by name for tool-call dispatch. */
export function findPluginAgentTool(
  name: string,
): { pluginId: string; record: PluginAgentToolRecord } | undefined {
  return contributions?.findAgentTool?.(name);
}

/**
 * Resolve one plugin mention at send time (design §4.9). Fails closed: with
 * no live plugin service (tests that never build an app) a plugin mention
 * cannot be resolved, and the send path blocks rather than silently
 * dropping the context the user asked for.
 */
export async function resolvePluginMention(args: {
  pluginId: string;
  itemId: string;
}): Promise<PluginMentionResolveResult> {
  const active = contributions;
  if (!active?.resolveMention) {
    return {
      ok: false,
      error: "plugin mention resolution is unavailable on this server",
    };
  }
  return active.resolveMention(args);
}

/** Run a native plugin tool call (failure-isolated by the plugin service). */
export async function invokePluginAgentTool(
  tool: { pluginId: string; record: PluginAgentToolRecord },
  args: { input: unknown; ctx: PluginAgentToolContext },
): Promise<ToolCallResponse> {
  const active = contributions;
  if (!active?.invokeAgentTool) {
    return {
      success: false,
      contentItems: [
        { type: "inputText", text: `Unsupported tool: ${tool.record.name}` },
      ],
    };
  }
  return active.invokeAgentTool({
    pluginId: tool.pluginId,
    record: tool.record,
    input: args.input,
    ctx: args.ctx,
  });
}
