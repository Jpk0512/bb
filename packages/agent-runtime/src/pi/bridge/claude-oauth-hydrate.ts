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
export type ClaudeOAuthEnsureResult = "live" | "refreshed" | "unauthenticated";

/** Public Claude Code OAuth client. Token endpoint is the current CLI target. */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

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

export interface ClaudeOAuthCandidate {
  source: string;
  tokens: ClaudeOAuthTokens;
}

export interface RefreshClaudeOAuthTokensArgs {
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export interface EnsureClaudeOAuthFreshOptions {
  agentDir: string;
  now?: number;
  readCandidates?: () => Promise<ClaudeOAuthCandidate[]>;
  refreshTokens?: (
    refreshToken: string,
  ) => Promise<ClaudeOAuthTokens | null>;
  writeStores?: (tokens: ClaudeOAuthTokens) => Promise<void>;
  hydrate?: typeof hydratePiAnthropicFromClaude;
}

interface ClaudeOAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * Exchange a Claude Code refresh token for a new access/refresh pair.
 * Returns null on invalid_grant or a malformed body — never throws a token.
 */
export async function refreshClaudeOAuthTokens(
  args: RefreshClaudeOAuthTokensArgs,
): Promise<ClaudeOAuthTokens | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? Date.now();
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body: JSON.stringify({
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: args.refreshToken,
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const body = json as ClaudeOAuthTokenResponse;
  if (!isNonEmptyString(body.access_token)) {
    return null;
  }
  const refreshToken = isNonEmptyString(body.refresh_token)
    ? body.refresh_token
    : args.refreshToken;
  const expiresIn =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 8 * 60 * 60;
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
  };
}

async function defaultReadCandidates(): Promise<ClaudeOAuthCandidate[]> {
  const candidates: ClaudeOAuthCandidate[] = [];
  const claude = await readClaudeOAuthTokens();
  if (claude) {
    candidates.push({ source: "claude", tokens: claude });
  }
  return candidates;
}

async function readPiAnthropicCandidate(
  agentDir: string,
): Promise<ClaudeOAuthCandidate | null> {
  const raw = await defaultReadAuthFile(join(agentDir, "auth.json"));
  const entry = readPiOAuthEntry(parsePiAuthFile(raw)[PI_ANTHROPIC_PROVIDER]);
  if (!entry) {
    return null;
  }
  return {
    source: "pi",
    tokens: {
      accessToken: entry.access,
      refreshToken: entry.refresh,
      expiresAt: entry.expires,
    },
  };
}

async function writeClaudeCredentialsFile(
  tokens: ClaudeOAuthTokens,
): Promise<void> {
  const path = join(homedir(), ".claude", ".credentials.json");
  const existingRaw = await defaultReadAuthFile(path);
  const existing = parsePiAuthFile(existingRaw);
  const previous =
    typeof existing.claudeAiOauth === "object" && existing.claudeAiOauth !== null
      ? (existing.claudeAiOauth as Record<string, unknown>)
      : {};
  existing.claudeAiOauth = {
    ...previous,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
  await defaultWriteAuthFile(path, `${JSON.stringify(existing, null, 2)}\n`);
}

async function writeClaudeKeychain(tokens: ClaudeOAuthTokens): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  const payload = JSON.stringify({
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
  });
  try {
    await execFileAsync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        CLAUDE_KEYCHAIN_SERVICE,
        "-a",
        userInfo().username,
        "-w",
        payload,
      ],
      { timeout: 10_000 },
    );
  } catch {
    // File write is enough for the next CLI read; keychain is best-effort.
  }
}

async function defaultWriteStores(
  agentDir: string,
  tokens: ClaudeOAuthTokens,
): Promise<void> {
  await writeClaudeCredentialsFile(tokens);
  await writeClaudeKeychain(tokens);
  await hydratePiAnthropicFromClaude({
    agentDir,
    readClaudeTokens: async () => tokens,
  });
}

function compareCandidatesNewestFirst(
  left: ClaudeOAuthCandidate,
  right: ClaudeOAuthCandidate,
): number {
  return (right.tokens.expiresAt ?? 0) - (left.tokens.expiresAt ?? 0);
}

/**
 * Make sure Claude Code and Pi share one live Anthropic session.
 *
 * The previous hydrate-only path refused to touch an expired access token
 * because each consumer refreshed independently and rotated the other off.
 * Refresh here, then write the new pair to the credentials file, the
 * canonical keychain item, and Pi's auth.json so rotation cannot split them.
 */
export async function ensureClaudeOAuthFresh(
  options: EnsureClaudeOAuthFreshOptions,
): Promise<ClaudeOAuthEnsureResult> {
  const now = options.now ?? Date.now();
  const hydrate = options.hydrate ?? hydratePiAnthropicFromClaude;
  const fromClaude = await (options.readCandidates ?? defaultReadCandidates)();
  const fromPi = await readPiAnthropicCandidate(options.agentDir);
  const candidates = [...fromClaude, ...(fromPi ? [fromPi] : [])];

  const live = candidates.find((candidate) =>
    isLiveAccess(candidate.tokens.expiresAt, now),
  );
  if (live) {
    await hydrate({
      agentDir: options.agentDir,
      now,
      readClaudeTokens: async () => live.tokens,
    });
    return "live";
  }

  const refreshable = [...candidates]
    .filter((candidate) => candidate.tokens.refreshToken.length > 0)
    .sort(compareCandidatesNewestFirst);
  const refresh =
    options.refreshTokens ??
    ((refreshToken: string) =>
      refreshClaudeOAuthTokens({ refreshToken, now }));

  for (const candidate of refreshable) {
    const next = await refresh(candidate.tokens.refreshToken);
    if (!next) {
      continue;
    }
    if (options.writeStores) {
      await options.writeStores(next);
    } else {
      await defaultWriteStores(options.agentDir, next);
    }
    return "refreshed";
  }
  return "unauthenticated";
}
