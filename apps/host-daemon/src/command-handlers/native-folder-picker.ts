import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import { sanitizeInheritedChildProcessEnv } from "@bb/process-utils";
import { ExpectedCommandDispatchError } from "../command-dispatch-support.js";

const execFileAsync = promisify(execFile);

// The daemon is a background process (launchd), so an osascript it spawns
// checks in with the window server as a UIElement app: its `choose folder`
// panel opens behind every window, unfocused, and no `activate` can front a
// UIElement — the click looks like a no-op. Switching the process to the
// regular activation policy before activating is what makes the panel appear
// frontmost, and only JXA's ObjC bridge can reach that API. Cancel resolves
// to "" (null path) rather than an error, matching the old AppleScript.
const CHOOSE_FOLDER_JXA = [
  'ObjC.import("Cocoa");',
  "$.NSApplication.sharedApplication;",
  "$.NSApp.setActivationPolicy($.NSApplicationActivationPolicyRegular);",
  "$.NSApp.activateIgnoringOtherApps(true);",
  "const app = Application.currentApplication();",
  "app.includeStandardAdditions = true;",
  'let result = "";',
  "try {",
  '  result = app.chooseFolder({ withPrompt: "Choose a project folder" }).toString();',
  "} catch (error) {",
  '  result = "";',
  "}",
  "result;",
].join("\n");

export async function pickHostFolder(): Promise<
  HostDaemonOnlineRpcResult<"host.pick_folder">
> {
  if (process.platform !== "darwin") {
    throw new ExpectedCommandDispatchError(
      "unsupported_platform",
      "Folder picker is only supported on macOS",
    );
  }

  let stdout: string;
  try {
    const result = await execFileAsync(
      "osascript",
      ["-l", "JavaScript", "-e", CHOOSE_FOLDER_JXA],
      {
        env: sanitizeInheritedChildProcessEnv({ env: process.env }),
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new ExpectedCommandDispatchError(
      "folder_picker_failed",
      `Folder picker failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const selectedPath = stdout.trim();
  return { path: selectedPath === "" ? null : selectedPath.replace(/\/$/, "") };
}
