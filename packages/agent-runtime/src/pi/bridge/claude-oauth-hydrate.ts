import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const PI_ANTHROPIC_PROVIDER = "anthropic";
const ACCESS_EXPIRY_SKEW_MS = 60_000;

export interface ClaudeOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

export interface PiOAuthEntry {
  type: "oauth";
  access: string;
  expires: number;
  refresh: string;
}

export type ClaudeOAuthHydrateResult = "copied" | "skipped" | "unchanged";

export interface HydratePiAnthropicFromClaudeOptions {
  agentDir: string;
  now?: number;
  readClaudeTokens?: () => Promise<ClaudeOAuthTokens | null>;
  readAuthFile?: (path: string) => Promise<string | null>;
  writeAuthFile?: (path: string, contents: string) => Promise<void>;
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseClaudeTokens(raw: string): ClaudeOAuthTokens | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const oauth = (json as ClaudeCredentialsFile).claudeAiOauth;
  if (!oauth || !isNonEmptyString(oauth.accessToken)) {
    return null;
  }
  if (!isNonEmptyString(oauth.refreshToken)) {
    return null;
  }
  const expiresAt =
    typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
      ? oauth.expiresAt
      : null;
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt,
  };
}

async function readClaudeKeychainCredentials(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const argumentSets = [
    [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-a",
      userInfo().username,
      "-w",
    ],
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
  ];
  for (const args of argumentSets) {
    try {
      const { stdout } = await execFileAsync("security", args, {
        timeout: 10_000,
      });
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    } catch {
      // Try the next lookup, then fall back to the credentials file.
    }
  }
  return null;
}

async function readClaudeFileCredentials(): Promise<string | null> {
  try {
    return await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
  } catch {
    return null;
  }
}

export async function readClaudeOAuthTokens(): Promise<ClaudeOAuthTokens | null> {
  const raw =
    (await readClaudeKeychainCredentials()) ??
    (await readClaudeFileCredentials());
  if (!raw) {
    return null;
  }
  return parseClaudeTokens(raw);
}

function isLiveAccess(expiresAt: number | null, now: number): boolean {
  if (expiresAt === null) {
    return true;
  }
  return expiresAt > now + ACCESS_EXPIRY_SKEW_MS;
}

function parsePiAuthFile(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
      return json as Record<string, unknown>;
    }
  } catch {
    // Replace a corrupt file rather than fail session start.
  }
  return {};
}

function readPiOAuthEntry(value: unknown): PiOAuthEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (entry.type !== "oauth") {
    return null;
  }
  if (!isNonEmptyString(entry.access) || !isNonEmptyString(entry.refresh)) {
    return null;
  }
  if (typeof entry.expires !== "number" || !Number.isFinite(entry.expires)) {
    return null;
  }
  return {
    type: "oauth",
    access: entry.access,
    expires: entry.expires,
    refresh: entry.refresh,
  };
}

async function defaultReadAuthFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function defaultWriteAuthFile(
  path: string,
  contents: string,
): Promise<void> {
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

/**
 * Copy a *live* Claude Code OAuth session into Pi's `auth.json`.
 *
 * Claude Code (keychain / `~/.claude/.credentials.json`) and Pi
 * (`~/.pi/agent/auth.json`) keep separate Anthropic OAuth copies. When the
 * access token expires, each consumer refreshes independently and rotates the
 * shared refresh token out from under the other — which is why Claude has to
 * be signed in again every day. After a successful `claude auth login`, this
 * copies the fresh pair into Pi so Pi threads stop failing with
 * `invalid_grant` while Claude Code still looks signed in.
 *
 * Dead Claude access tokens are not copied: writing those would make Pi try
 * a refresh and rotate Claude Code's token again.
 */
export async function hydratePiAnthropicFromClaude(
  options: HydratePiAnthropicFromClaudeOptions,
): Promise<ClaudeOAuthHydrateResult> {
  const now = options.now ?? Date.now();
  const claude = await (options.readClaudeTokens ?? readClaudeOAuthTokens)();
  if (!claude || !isLiveAccess(claude.expiresAt, now)) {
    return "skipped";
  }

  const authPath = join(options.agentDir, "auth.json");
  const existingRaw = await (options.readAuthFile ?? defaultReadAuthFile)(
    authPath,
  );
  const authFile = parsePiAuthFile(existingRaw);
  const existing = readPiOAuthEntry(authFile[PI_ANTHROPIC_PROVIDER]);
  if (
    existing &&
    existing.access === claude.accessToken &&
    existing.refresh === claude.refreshToken &&
    isLiveAccess(existing.expires, now)
  ) {
    return "unchanged";
  }

  const nextEntry: PiOAuthEntry = {
    type: "oauth",
    access: claude.accessToken,
    refresh: claude.refreshToken,
    expires: claude.expiresAt ?? now + 8 * 60 * 60 * 1000,
  };
  authFile[PI_ANTHROPIC_PROVIDER] = nextEntry;
  await (options.writeAuthFile ?? defaultWriteAuthFile)(
    authPath,
    `${JSON.stringify(authFile, null, 2)}\n`,
  );
  return "copied";
}
