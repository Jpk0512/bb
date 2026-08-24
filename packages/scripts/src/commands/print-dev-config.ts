import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDesktopUserDataDir,
  resolveDevInstanceConfig,
  type DevInstanceConfig,
} from "@bb/config/runtime";

interface FormatDevConfigShellAssignmentsArgs {
  config: DevInstanceConfig;
  env: NodeJS.ProcessEnv;
}

const commandDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(commandDir, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");

// Single-quoting is what makes the output safe for the `eval` in
// scripts/bb-dev-app: a data dir can contain characters the shell expands.
function toShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Resolved dev-instance settings as shell assignments. scripts/bb-dev-app evals
 * this instead of recomputing ports, so the launcher cannot disagree with the
 * `pnpm dev` it starts — including when an env file overrides a port.
 */
export function formatDevConfigShellAssignments(
  args: FormatDevConfigShellAssignmentsArgs,
): string {
  const assignments: readonly (readonly [string, string])[] = [
    ["BB_DEV_APP_PORT", String(args.config.ports.appPort)],
    ["BB_HOST_DAEMON_PORT", String(args.config.ports.hostDaemonPort)],
    ["BB_SERVER_PORT", String(args.config.ports.serverPort)],
    ["BB_SERVER_URL", args.config.serverUrl],
    ["DATA_DIR", args.config.dataDir],
    [
      "DESKTOP_USER_DATA_DIR",
      resolveDesktopUserDataDir({
        dataDir: args.config.dataDir,
        env: args.env,
      }),
    ],
    ["INSTANCE_ID", args.config.instanceId],
  ];

  return assignments
    .map(([name, value]) => `${name}=${toShellSingleQuoted(value)}`)
    .join("\n");
}

export function main(): void {
  const config = resolveDevInstanceConfig({
    env: process.env,
    homeDir: homedir(),
    repoRoot,
  });
  process.stdout.write(
    `${formatDevConfigShellAssignments({ config, env: process.env })}\n`,
  );
}

if (
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
