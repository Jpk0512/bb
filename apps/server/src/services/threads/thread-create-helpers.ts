import {
  createThread,
  getThreadSectionById,
  getProjectSourceByHost,
  getProject,
  getThread,
  isSqliteForeignKeyConstraint,
} from "@bb/db";
import type { DbNotifier } from "@bb/db";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { LocalPathProjectSource } from "@bb/domain";
import type { BaseBranchSpec } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import { appendChildSessionLifecycleEvent } from "./thread-events.js";
import type { ThreadCreateServiceRequest } from "./thread-create-request.js";
import { sanitizeGeneratedBranchSlug } from "./title-generation.js";

/**
 * Convert a {@link BaseBranchSpec} to the stored/wire branch-name shape.
 * `{ kind: "default" }` becomes `null`, which means the source's default
 * branch.
 */
export function baseBranchSpecToStoredName(
  spec: BaseBranchSpec,
): string | null {
  return spec.kind === "named" ? spec.name : null;
}

export function storedBaseBranchNameToSpec(
  name: string | null,
): BaseBranchSpec {
  return name ? { kind: "named", name } : { kind: "default" };
}

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.provision" }
>;
type EnvironmentProvisionCommandInitiator =
  EnvironmentProvisionCommand["initiator"];

interface ManagedBranchNameArgs {
  branchSlug?: string | null;
  threadId: string;
}

export function buildManagedBranchName(args: ManagedBranchNameArgs): string {
  const branchSlug = args.branchSlug
    ? sanitizeGeneratedBranchSlug(args.branchSlug)
    : null;
  return branchSlug
    ? `bb/${branchSlug}-${args.threadId}`
    : `bb/${args.threadId}`;
}

export function requirePublicProjectForThreadCreate(
  deps: Pick<AppDeps, "db">,
  projectId: string,
) {
  const project = getProject(deps.db, projectId);
  if (!project || project.deletedAt !== null) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

export const SETUP_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export function requireSourceForHost(
  deps: Pick<AppDeps, "db">,
  projectId: string,
  hostId: string,
): LocalPathProjectSource {
  const source = getProjectSourceByHost(deps.db, projectId, hostId);
  if (!source || source.type !== "local_path") {
    throw new ApiError(
      409,
      "invalid_request",
      "No project source configured for this host",
    );
  }
  return source;
}

/**
 * Pre-provision checkout for unmanaged workspaces, fully resolved on the
 * server (the daemon receives an explicit branch name in both kinds).
 */
export type UnmanagedCheckoutCommand =
  | { kind: "existing"; name: string }
  | { kind: "new"; name: string; baseBranch: string };

type EnvironmentProvisionCommandArgs =
  | {
      workspaceProvisionType: "unmanaged";
      environmentId: string;
      hostId: string;
      initiator: EnvironmentProvisionCommandInitiator;
      path: string;
      checkout?: UnmanagedCheckoutCommand;
    }
  | {
      workspaceProvisionType: "managed-worktree";
      environmentId: string;
      hostId: string;
      initiator: EnvironmentProvisionCommandInitiator;
      sourcePath: string;
      targetPath: string;
      branchName: string;
      baseBranch: BaseBranchSpec;
      setupTimeoutMs: number;
    }
  | {
      workspaceProvisionType: "personal";
      environmentId: string;
      hostId: string;
      initiator: EnvironmentProvisionCommandInitiator;
      targetPath: string;
    };

export function buildEnvironmentProvisionCommand(
  args: EnvironmentProvisionCommandArgs,
): EnvironmentProvisionCommand {
  switch (args.workspaceProvisionType) {
    case "unmanaged":
      return {
        type: "environment.provision" as const,
        environmentId: args.environmentId,
        initiator: args.initiator,
        workspaceProvisionType: args.workspaceProvisionType,
        path: args.path,
        ...(args.checkout ? { checkout: args.checkout } : {}),
      };
    case "managed-worktree":
      return {
        type: "environment.provision" as const,
        environmentId: args.environmentId,
        initiator: args.initiator,
        workspaceProvisionType: args.workspaceProvisionType,
        sourcePath: args.sourcePath,
        targetPath: args.targetPath,
        branchName: args.branchName,
        baseBranch: baseBranchSpecToStoredName(args.baseBranch),
        setupTimeoutMs: args.setupTimeoutMs,
      };
    case "personal":
      return {
        type: "environment.provision" as const,
        environmentId: args.environmentId,
        initiator: args.initiator,
        workspaceProvisionType: args.workspaceProvisionType,
        targetPath: args.targetPath,
      };
  }
}

export function createThreadRecord(
  deps: Pick<AppDeps, "db"> & { hub: DbNotifier },
  args: {
    environmentId: string | null;
    request: ThreadCreateServiceRequest;
    /**
     * The model the child will actually run, after defaults are resolved.
     *
     * The spawn lifecycle event used to record `request.model`, which is null
     * in exactly the case that matters — the caller omitted a model and a
     * default cascade chose one — so a parent watching its children could not
     * see which model any of them got. Pass the resolved value so the inline
     * child block and the board can show it.
     */
    resolvedModel?: string | null;
    status?: "starting";
  },
) {
  const sectionId = args.request.sectionId ?? null;
  if (sectionId !== null && !getThreadSectionById(deps.db, sectionId)) {
    throw new ApiError(404, "section_not_found", "Section not found");
  }

  try {
    const thread = createThread(deps.db, deps.hub, {
      projectId: args.request.projectId,
      environmentId: args.environmentId,
      providerId: args.request.providerId,
      title: args.request.title ?? null,
      titleFallback: args.request.titleFallback,
      sectionId,
      parentThreadId: args.request.parentThreadId ?? null,
      sourceThreadId: args.request.sourceThreadId ?? null,
      originKind: args.request.originKind,
      originPluginId: args.request.originPluginId ?? null,
      childKind: args.request.childKind ?? null,
      ...(args.request.agentConfiguration && args.request.originPluginId
        ? {
            pluginAgentConfiguration: {
              instructions:
                args.request.agentConfiguration.instructions ?? null,
              pluginId: args.request.originPluginId,
              skillsJson: JSON.stringify(
                args.request.agentConfiguration.skills,
              ),
              toolsJson: JSON.stringify(args.request.agentConfiguration.tools),
            },
          }
        : {}),
      visibility: args.request.visibility,
      status: "starting",
    });
    emitPluginThreadCreated(thread);
    if (thread.parentThreadId !== null && thread.childKind !== null) {
      appendChildSessionLifecycleEvent(deps, {
        childKind: thread.childKind,
        childThreadId: thread.id,
        model: args.resolvedModel ?? args.request.model ?? null,
        outputExcerpt: null,
        parentThreadId: thread.parentThreadId,
        providerId: thread.providerId,
        scope: "spawn",
        status: "started",
        statusReason: null,
        title: thread.title ?? thread.titleFallback ?? "Child session",
      });
    }
    return thread;
  } catch (error) {
    if (
      sectionId !== null &&
      error instanceof Error &&
      isSqliteForeignKeyConstraint(error) &&
      !getThreadSectionById(deps.db, sectionId)
    ) {
      throw new ApiError(404, "section_not_found", "Section not found");
    }
    throw error;
  }
}

export function getThreadSafe(deps: Pick<AppDeps, "db">, threadId: string) {
  const thread = getThread(deps.db, threadId);
  if (!thread) {
    throw new ApiError(500, "internal_error", "Thread was not created");
  }
  return thread;
}
