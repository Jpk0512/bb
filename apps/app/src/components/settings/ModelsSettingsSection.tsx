import { useMemo, useState } from "react";
import type { AvailableModel, DisabledModels, ProviderInfo } from "@bb/domain";
import { isModelDisabled } from "@bb/domain";
import { Switch } from "@bb/shared-ui/switch";
import { Icon } from "@bb/shared-ui/icon";
import {
  SettingsSection,
  SettingsRow,
  SettingsRowList,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import {
  useDisabledModels,
  useSystemExecutionOptions,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import { useUpdateDisabledModels } from "@/hooks/mutations/settings-mutations";

/**
 * Curate which models bb offers.
 *
 * Providers such as pi advertise every model of every configured sub-provider,
 * which makes the picker unusable when only a handful are actually in use.
 * Turning a model off withdraws it from the picker, from new-thread defaults,
 * and from what an orchestrator may select — it does not break threads that
 * already run on it, and it can always be turned back on.
 */
export function ModelsSettingsSection() {
  const providersQuery = useSystemProviders();
  const disabledModelsQuery = useDisabledModels();
  const updateDisabledModels = useUpdateDisabledModels();
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );

  const providers = useMemo(
    () => (providersQuery.data ?? []).filter((provider) => provider.available),
    [providersQuery.data],
  );
  const activeProviderId = selectedProviderId ?? providers[0]?.id ?? null;

  if (providersQuery.isLoading) {
    return (
      <SettingsSection title="Models">
        <p className="text-xs text-subtle-foreground/75">Loading providers…</p>
      </SettingsSection>
    );
  }
  if (providers.length === 0) {
    return (
      <SettingsSection
        title="Models"
        description="Choose which models bb offers in the model picker."
      >
        <p className="text-xs text-subtle-foreground/75">
          No providers are available on this machine yet.
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Models"
      description="Turn off the models you never use. They disappear from the picker and from new-thread defaults; threads already running on one keep working."
    >
      <div className="space-y-4">
        <ProviderTabs
          activeProviderId={activeProviderId}
          onSelect={setSelectedProviderId}
          providers={providers}
        />
        {activeProviderId === null ? null : (
          <ProviderModelList
            disabled={
              disabledModelsQuery.data === undefined ||
              updateDisabledModels.isPending
            }
            disabledModels={disabledModelsQuery.data ?? []}
            onToggle={(model, enabled) => {
              const current = disabledModelsQuery.data ?? [];
              const next = enabled
                ? current.filter(
                    (entry) =>
                      entry.providerId !== activeProviderId ||
                      entry.model !== model,
                  )
                : [...current, { providerId: activeProviderId, model }];
              updateDisabledModels.mutate(next);
            }}
            providerId={activeProviderId}
          />
        )}
      </div>
    </SettingsSection>
  );
}

function ProviderTabs({
  activeProviderId,
  onSelect,
  providers,
}: {
  activeProviderId: string | null;
  onSelect: (providerId: string) => void;
  providers: ProviderInfo[];
}) {
  if (providers.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          onClick={() => onSelect(provider.id)}
          aria-pressed={provider.id === activeProviderId}
          className={
            provider.id === activeProviderId
              ? "rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs text-foreground"
              : "rounded-full border border-border px-2.5 py-1 text-xs text-subtle-foreground hover:border-primary/60"
          }
        >
          {provider.displayName}
        </button>
      ))}
    </div>
  );
}

function ProviderModelList({
  disabled,
  disabledModels,
  onToggle,
  providerId,
}: {
  disabled: boolean;
  disabledModels: DisabledModels;
  onToggle: (model: string, enabled: boolean) => void;
  providerId: string;
}) {
  const executionOptionsQuery = useSystemExecutionOptions({ providerId });

  // A disabled model is demoted into `selectedOnlyModels`, so the full roster
  // this page must render is both lists — otherwise turning a model off would
  // make its own switch disappear.
  const rows = useMemo(() => {
    const response = executionOptionsQuery.data;
    if (response === undefined) return [];
    const byModel = new Map<string, AvailableModel>();
    for (const model of [...response.models, ...response.selectedOnlyModels]) {
      byModel.set(model.model, model);
    }
    return [...byModel.values()].sort((left, right) =>
      left.model.localeCompare(right.model),
    );
  }, [executionOptionsQuery.data]);

  if (executionOptionsQuery.isLoading) {
    return (
      <p className="text-xs text-subtle-foreground/75">Loading models…</p>
    );
  }
  if (executionOptionsQuery.data?.modelLoadError) {
    return (
      <div className="flex items-start gap-2 text-xs text-subtle-foreground/75">
        <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" />
        <p>
          The model list could not be loaded for this provider, so it cannot be
          curated right now. Existing choices are unaffected.
        </p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-xs text-subtle-foreground/75">
        This provider reports no models.
      </p>
    );
  }

  const enabledCount = rows.filter(
    (model) => !isModelDisabled(disabledModels, { providerId, model: model.model }),
  ).length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-subtle-foreground/75">
        {enabledCount} of {rows.length} offered
      </p>
      <SettingsRowList>
        {rows.map((model) => {
          const off = isModelDisabled(disabledModels, {
            providerId,
            model: model.model,
          });
          return (
            <SettingsRow key={model.model}>
              <div className="min-w-0 flex-1">
                <SettingsWithControl
                  label={model.displayName || model.model}
                  {...(model.displayName && model.displayName !== model.model
                    ? { description: model.model }
                    : {})}
                >
                  <Switch
                    checked={!off}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onToggle(model.model, checked)
                    }
                    aria-label={`Offer ${model.displayName || model.model}`}
                  />
                </SettingsWithControl>
              </div>
            </SettingsRow>
          );
        })}
      </SettingsRowList>
      {enabledCount === 0 ? (
        <div className="flex items-start gap-2 text-xs text-subtle-foreground/75">
          <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" />
          <p>
            Every model here is off, so new threads on this provider cannot pick
            one. Leave at least one on.
          </p>
        </div>
      ) : null}
    </div>
  );
}
