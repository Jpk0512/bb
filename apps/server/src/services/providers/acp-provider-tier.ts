/**
 * The dynamic ACP tier.
 *
 * Every other provider is a plugin declaration in the registry. ACP ids are
 * different: known agents (`acp-opencode`, `acp-omp`, …) and user-configured
 * custom agents (`acp-<slug>`) are resolved from launch specs at request time
 * and are never declared, so they need a shared capability answer.
 */
import type {
  ProviderCapabilities,
  ProviderComposerAction,
  ProviderInfo,
  ProviderFork,
  ReasoningLevel,
} from "@bb/domain";
import type { ProviderServerCapabilities } from "./provider-registry.js";

export const ACP_TIER_CAPABILITIES: ProviderCapabilities = {
  supportsThreadArchive: false,
  supportsThreadRename: false,
  supportsServiceTier: true,
  supportsNativeUserQuestion: false,
  supportsFork: true,
  supportsSessionRewind: false,
  permissionModes: ["accept-edits", "full"],
  modelCatalogScope: "host",
};

const ACP_FORK: ProviderFork = "tip";

const ACP_COMPOSER_ACTIONS: readonly ProviderComposerAction[] = [
  { kind: "skills", trigger: "/" },
];

const ACP_REASONING_LEVELS: readonly ReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const ACP_SERVER_CAPABILITIES: ProviderServerCapabilities = {
  reasoningLevels: ACP_REASONING_LEVELS,
  fork: ACP_FORK,
  supportsManualCompaction: false,
};

export function isAcpProviderId(value: string): boolean {
  return value.startsWith("acp-");
}

function requireAcpProviderId(providerId: string): void {
  if (!isAcpProviderId(providerId)) {
    throw new Error(`ACP provider id "${providerId}" must start with "acp-".`);
  }
}

export interface BuildAcpProviderInfoArgs {
  id: string;
  displayName: string;
  logoUrl: string | null;
}

export function buildAcpProviderInfo(
  args: BuildAcpProviderInfoArgs,
): ProviderInfo {
  requireAcpProviderId(args.id);
  return {
    id: args.id,
    pluginId: "provider-acp",
    displayName: args.displayName,
    logoUrl: args.logoUrl,
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      ...ACP_TIER_CAPABILITIES,
      permissionModes: [...ACP_TIER_CAPABILITIES.permissionModes],
    },
    composerActions: ACP_COMPOSER_ACTIONS.map((action) =>
      action.kind === "skills"
        ? { kind: "skills", trigger: action.trigger }
        : { ...action },
    ),
    available: true,
  };
}

export function getAcpProviderServerCapabilities(
  providerId: string,
): ProviderServerCapabilities {
  requireAcpProviderId(providerId);
  return ACP_SERVER_CAPABILITIES;
}
