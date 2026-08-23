import { Command } from "commander";
import type { AvailableModel, DisabledModels } from "@bb/domain";
import type { ProviderHostRoutingArgs } from "@bb/sdk";
import type { SystemProviderInfo } from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";
import { resolveMachineEnvironmentRouting } from "./machine.js";

interface ProviderListCommandOptions {
  environment?: string;
  host?: string;
  json?: boolean;
  machine?: string;
}

interface ProviderModelsCommandOptions {
  environment?: string;
  host?: string;
  json?: boolean;
  machine?: string;
  selectedModel?: string;
}

interface IncludeSelectedOnlyModelArgs {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
  selectedModel?: string;
}

async function resolveProviderRouting(
  opts: ProviderListCommandOptions,
  serverUrl: string,
): Promise<ProviderHostRoutingArgs> {
  return resolveMachineEnvironmentRouting(opts, serverUrl);
}

function addProviderRoutingOptions(command: Command): Command {
  return command
    .option("--machine <id-or-name>", "Machine whose providers should be used")
    .option("--host <id-or-name>", "Alias for --machine")
    .option(
      "--environment <id>",
      "Environment whose machine providers should be used",
    );
}

export function registerProviderCommands(
  program: Command,
  getUrl: () => string,
): void {
  const provider = program
    .command("provider")
    .description("Inspect available providers and models");

  addProviderRoutingOptions(provider.command("list"))
    .description("List available providers")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ProviderListCommandOptions) => {
        const serverUrl = getUrl();
        const sdk = createCliBbSdk(serverUrl);
        const providers = await sdk.providers.list(
          await resolveProviderRouting(opts, serverUrl),
        );
        if (outputJson(opts, providers)) return;
        if (providers.length === 0) {
          console.log("No providers available");
          return;
        }
        printProviderTable(providers);
      }),
    );

  addProviderRoutingOptions(provider.command("models [providerId]"))
    .description("List available models for a provider")
    .option("--json", "Print machine-readable JSON output")
    .option(
      "--selected-model <model>",
      "Include a selected-only model if it matches",
    )
    .action(
      action(
        async (
          providerId: string | undefined,
          opts: ProviderModelsCommandOptions,
        ) => {
          const serverUrl = getUrl();
          const sdk = createCliBbSdk(serverUrl);
          const executionOptions = await sdk.providers.models({
            ...(await resolveProviderRouting(opts, serverUrl)),
            ...(providerId ? { providerId } : {}),
          });
          const models = includeSelectedOnlyModel({
            models: executionOptions.models,
            selectedOnlyModels: executionOptions.selectedOnlyModels,
            selectedModel: opts.selectedModel,
          });
          if (outputJson(opts, models)) return;
          if (models.length === 0) {
            console.log("No models available");
            return;
          }
          printModelTable(models, providerId);
        },
      ),
    );

  const disabledModels = provider
    .command("disabled")
    .description("Manage which models bb offers");

  disabledModels
    .command("list")
    .description("List models that are disabled")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: { json?: boolean }) => {
        const sdk = createCliBbSdk(getUrl());
        const disabled = await sdk.providers.disabledModels();
        if (outputJson(opts, disabled)) return;
        if (disabled.length === 0) {
          console.log("No models are disabled");
          return;
        }
        printDisabledModelTable(disabled);
      }),
    );

  disabledModels
    .command("add <providerId> <model>")
    .description("Stop offering a model without breaking threads that use it")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (providerId: string, model: string, opts: { json?: boolean }) => {
        const sdk = createCliBbSdk(getUrl());
        const current = await sdk.providers.disabledModels();
        if (
          current.some(
            (entry) => entry.providerId === providerId && entry.model === model,
          )
        ) {
          if (outputJson(opts, current)) return;
          console.log(`${providerId}/${model} is already disabled`);
          return;
        }
        const updated = await sdk.providers.setDisabledModels({
          disabledModels: [...current, { providerId, model }],
        });
        if (outputJson(opts, updated)) return;
        console.log(`Disabled ${providerId}/${model}`);
      }),
    );

  disabledModels
    .command("remove <providerId> <model>")
    .description("Offer a model again")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (providerId: string, model: string, opts: { json?: boolean }) => {
        const sdk = createCliBbSdk(getUrl());
        const current = await sdk.providers.disabledModels();
        const updated = await sdk.providers.setDisabledModels({
          disabledModels: current.filter(
            (entry) =>
              entry.providerId !== providerId || entry.model !== model,
          ),
        });
        if (outputJson(opts, updated)) return;
        console.log(`Enabled ${providerId}/${model}`);
      }),
    );
}

function printDisabledModelTable(disabled: DisabledModels): void {
  const rows = disabled.map((entry) => [entry.providerId, entry.model]);
  const providerWidth = Math.max(8, ...rows.map((row) => row[0].length));
  const modelWidth = Math.max(5, ...rows.map((row) => row[1].length));
  const table = renderBorderlessTable(
    {
      head: ["Provider", "Model"],
      colWidths: [providerWidth, modelWidth],
      trimTrailingWhitespace: true,
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}

function includeSelectedOnlyModel(
  args: IncludeSelectedOnlyModelArgs,
): AvailableModel[] {
  if (!args.selectedModel) {
    return args.models;
  }
  if (args.models.some((model) => model.model === args.selectedModel)) {
    return args.models;
  }
  const selectedOnlyModel = args.selectedOnlyModels.find(
    (model) => model.model === args.selectedModel,
  );
  return selectedOnlyModel ? [selectedOnlyModel, ...args.models] : args.models;
}

function printProviderTable(providers: SystemProviderInfo[]): void {
  const rows = providers.map((provider) => [provider.id, provider.displayName]);
  const idWidth = Math.max(4, ...rows.map((row) => row[0].length));
  const nameWidth = Math.max(4, ...rows.map((row) => row[1].length));
  const table = renderBorderlessTable(
    {
      head: ["ID", "Name"],
      colWidths: [idWidth, nameWidth],
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}

function printModelTable(models: AvailableModel[], providerId?: string): void {
  if (providerId) {
    console.log(`Models for ${providerId}:`);
  }

  const rows = models.map((model) => [
    model.model,
    model.displayName ?? model.model,
    model.isDefault ? "*" : "",
  ]);
  const modelWidth = Math.max(5, ...rows.map((row) => row[0].length));
  const nameWidth = Math.max(4, ...rows.map((row) => row[1].length));
  const defaultWidth = Math.max(7, ...rows.map((row) => row[2].length));
  const table = renderBorderlessTable(
    {
      head: ["Model", "Name", "Default"],
      colWidths: [modelWidth, nameWidth, defaultWidth],
      trimTrailingWhitespace: true,
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}
