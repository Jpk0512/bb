import { describe, expect, it } from "vitest";
import { resolveDevInstanceConfig } from "@bb/config/runtime";
import { formatDevConfigShellAssignments } from "../src/commands/print-dev-config.js";

const homeDir = "/Users/tester";
const repoRoot = "/Users/tester/src/bb";

function parseAssignments(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Z_]+)='(.*)'$/u.exec(line);
    if (match === null) {
      throw new Error(`bb-dev-app could not eval line: ${line}`);
    }
    values[match[1]] = match[2];
  }
  return values;
}

describe("print-dev-config", () => {
  it("publishes every value scripts/bb-dev-app evals", () => {
    const config = resolveDevInstanceConfig({ homeDir, repoRoot });

    const values = parseAssignments(
      formatDevConfigShellAssignments({ config, env: {} }),
    );

    expect(values).toEqual({
      BB_DEV_APP_PORT: String(config.ports.appPort),
      BB_HOST_DAEMON_PORT: String(config.ports.hostDaemonPort),
      BB_SERVER_PORT: String(config.ports.serverPort),
      BB_SERVER_URL: config.serverUrl,
      DATA_DIR: config.dataDir,
      DESKTOP_USER_DATA_DIR: `${config.dataDir}/desktop`,
      INSTANCE_ID: config.instanceId,
    });
  });

  it("carries a port override through to the launcher", () => {
    const env = { BB_DEV_APP_PORT: "5191" };
    const config = resolveDevInstanceConfig({ env, homeDir, repoRoot });

    const values = parseAssignments(
      formatDevConfigShellAssignments({ config, env }),
    );

    expect(values.BB_DEV_APP_PORT).toBe("5191");
    expect(values.BB_SERVER_PORT).toBe(String(config.ports.serverPort));
  });

  it("reports the desktop user data dir the desktop shell actually uses", () => {
    const env = { BB_DESKTOP_USER_DATA_DIR: "/tmp/desktop-profile" };
    const config = resolveDevInstanceConfig({ env, homeDir, repoRoot });

    const values = parseAssignments(
      formatDevConfigShellAssignments({ config, env }),
    );

    expect(values.DESKTOP_USER_DATA_DIR).toBe("/tmp/desktop-profile");
  });

  it("quotes values so the shell cannot expand or split them", () => {
    const quotedHomeDir = "/Users/o'brien $HOME dir";
    const config = resolveDevInstanceConfig({
      homeDir: quotedHomeDir,
      repoRoot: `${quotedHomeDir}/bb`,
    });

    const output = formatDevConfigShellAssignments({ config, env: {} });

    expect(output).toContain(`DATA_DIR='${config.dataDir.replace("'", `'\\''`)}'`);
    expect(parseAssignments(output.replace(/'\\''/gu, "'")).DATA_DIR).toBe(
      config.dataDir,
    );
  });
});
