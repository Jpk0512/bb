import {
  createEventId,
  getThread,
  getThreadExecutionOverride,
  PROVIDER_CHANGE_OPERATION,
  setThreadExecutionOverride,
  setThreadProvider,
} from "@bb/db";
import { threadScope } from "@bb/domain";
import type { AvailableModel, ReasoningLevel, Thread } from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { requireBridgeLaunchForProviderId } from "../system/provider-bridge-launch.js";
import { resolveSystemExecutionOptions } from "../system/execution-options.js";
import { requireThreadHostCommandEnvironment } from "./thread-command-environment.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import { resolveThreadExecutionOverrideUpdate } from "./thread-execution-override.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";

/**
 * In-place provider change.
 *
 * A bb thread keeps its id, its whole event log and timeline, its tabs, its
 * environment, its section, its parent, its pins and its plugin state; only
 * the native provider session is new. What it cannot keep is what the PROVIDER
 * owns: the new session starts with no conversation history, because a Claude
 * Code session cannot be transplanted into codex. A caller that needs context
 * carried across sends it as agent-only input on the next turn.
 *
 * The mechanism is small and lives elsewhere: the marker event this writes,
 * plus the `provider_generation` bump, make `getLastStoredProviderThreadId`
 * return null, so `prepareReadyThreadTurnCommand` cold-starts the next turn
 * against the thread's new `providerId` instead of resuming the retired
 * session. Everything in this file is the fail-closed scaffolding around that.
 */

/** The stored thread row, which carries `providerGeneration` alongside the public fields. */
export type StoredThread = NonNullable<ReturnType<typeof getThread>>;

export interface SwitchThreadProviderArgs {
  thread: Thread;
  providerId: string;
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
}

export async function switchThreadProvider(
  deps: AppDeps,
  args: SwitchThreadProviderArgs,
): Promise<StoredThread> {
  const { providerId, thread } = args;

  if (thread.archivedAt !== null) {
    throw new ApiError(
      409,
      "thread_not_writable",
      "Un-archive this thread before changing its provider.",
    );
  }
  if (providerId === thread.providerId) {
    throw new ApiError(
      400,
      "invalid_request",
      `This thread already runs on ${providerId}. Change the model with PATCH /threads/:id instead.`,
    );
  }

  // A missing bridge must fail here, not at the next turn. Otherwise the user
  // is told the switch succeeded and then discovers the thread cannot run.
  await deps.providerRegistry.whenRegistrationsSettled();
  requireBridgeLaunchForProviderId(deps, providerId);

  // The catalog load is a host round trip that 503s when the host is cold, so
  // only pay it when the caller pinned a model. With no model the override is
  // simply cleared and the next turn resolves the target provider's own
  // default — which also means a provider switch works while offline.
  const targetModels =
    args.model === undefined
      ? []
      : await loadProviderModels(deps, {
          environmentId: thread.environmentId,
          providerId,
        });
  // Validated against the TARGET provider's catalog. This is the one place a
  // cross-provider model is legal; PATCH /threads/:id still refuses it.
  const nextOverride = resolveThreadExecutionOverrideUpdate(
    deps.providerRegistry,
    {
      existing: getThreadExecutionOverride(deps.db, thread.id) ?? {
        modelOverride: null,
        reasoningLevelOverride: null,
      },
      // Presence-sensitive: an absent model/reasoning clears the stored
      // override rather than keeping one that names the retired provider's
      // catalog. `null` is the documented "clear" value.
      patch: {
        model: args.model ?? null,
        reasoningLevel: args.reasoningLevel ?? null,
      },
      models: targetModels,
      providerId,
      fallbackModel: null,
    },
  );

  const environment = requireThreadHostCommandEnvironment({
    db: deps.db,
    thread,
  });

  // Release BEFORE the write, and await it. A release reports its failure to
  // the caller (only an unreachable host is swallowed, because an unreachable
  // host holds no runtime to release), so a thread whose old session could not
  // be let go is never rebound.
  await stopThreadForCurrentState(deps, thread, environment);

  const updated = deps.db.transaction(
    (tx): StoredThread => {
      // Re-read inside the transaction: the awaited release above is a window
      // in which a concurrent switch could have landed. Rebinding twice would
      // leave a marker whose `previousProviderId` is a lie.
      const latest = getThread(tx, thread.id);
      if (!latest || latest.deletedAt !== null) {
        throw new ApiError(404, "thread_not_found", "Thread not found");
      }
      if (latest.archivedAt !== null) {
        throw new ApiError(
          409,
          "thread_not_writable",
          "Un-archive this thread before changing its provider.",
        );
      }
      if (latest.providerId !== thread.providerId) {
        throw new ApiError(
          409,
          "thread_not_writable",
          "This thread's provider changed while the switch was in flight.",
        );
      }

      const rebound = setThreadProvider(tx, {
        providerId,
        threadId: latest.id,
      });
      if (!rebound) {
        throw new ApiError(404, "thread_not_found", "Thread not found");
      }
      setThreadExecutionOverride(tx, {
        modelOverride: nextOverride.modelOverride,
        reasoningLevelOverride: nextOverride.reasoningLevelOverride,
        threadId: latest.id,
      });
      // The durable record of the switch, and the generation boundary itself.
      // `system/operation` takes a free-form operation string and renders
      // generically today, so this needs no event-schema migration — the same
      // shape `environment_directory_update` uses to swap an environment under
      // a live thread.
      appendThreadEventInTransaction(tx, {
        threadId: latest.id,
        ...(latest.environmentId !== null
          ? { environmentId: latest.environmentId }
          : {}),
        type: "system/operation",
        scope: threadScope(),
        data: {
          operation: PROVIDER_CHANGE_OPERATION,
          operationId: createEventId(),
          status: "completed",
          message: `Switched provider from ${thread.providerId} to ${providerId}`,
          metadata: {
            previousProviderId: thread.providerId,
            nextProviderId: providerId,
            generation: rebound.providerGeneration,
            model: nextOverride.modelOverride,
            reasoningLevel: nextOverride.reasoningLevelOverride,
          },
        },
      });
      return rebound;
    },
    { behavior: "immediate" },
  );

  deps.hub.notifyThread(thread.id, ["provider-changed", "events-appended"], {
    eventTypes: ["system/operation"],
    projectId: thread.projectId,
  });
  return updated;
}

async function loadProviderModels(
  deps: AppDeps,
  args: { environmentId: string | null; providerId: string },
): Promise<readonly AvailableModel[]> {
  const result = await resolveSystemExecutionOptions(deps, {
    providerId: args.providerId,
    ...(args.environmentId !== null
      ? { environmentId: args.environmentId }
      : {}),
  });
  if (result.modelLoadError !== null) {
    throw new ApiError(
      503,
      "model_catalog_unavailable",
      `Unable to load ${args.providerId} models to validate the switch. Try again once the host is connected.`,
    );
  }
  return [...result.models, ...result.selectedOnlyModels];
}
