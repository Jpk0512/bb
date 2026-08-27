import { describe, expect, it } from "vitest";
import {
  ensureClaudeOAuthFresh,
  hydratePiAnthropicFromClaude,
  refreshClaudeOAuthTokens,
  type ClaudeOAuthTokens,
} from "../claude-oauth-hydrate.js";

const NOW = 1_700_000_000_000;

function liveClaude(
  overrides: Partial<ClaudeOAuthTokens> = {},
): ClaudeOAuthTokens {
  return {
    accessToken: "claude-access",
    refreshToken: "claude-refresh",
    expiresAt: NOW + 6 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("hydratePiAnthropicFromClaude", () => {
  it("copies a live Claude session into an empty Pi auth file", async () => {
    let written: string | null = null;
    const result = await hydratePiAnthropicFromClaude({
      agentDir: "/tmp/pi-agent",
      now: NOW,
      readClaudeTokens: async () => liveClaude(),
      readAuthFile: async () => null,
      writeAuthFile: async (_path, contents) => {
        written = contents;
      },
    });

    expect(result).toBe("copied");
    expect(JSON.parse(written ?? "{}")).toEqual({
      anthropic: {
        type: "oauth",
        access: "claude-access",
        refresh: "claude-refresh",
        expires: NOW + 6 * 60 * 60 * 1000,
      },
    });
  });

  it("overwrites a stale Pi Anthropic entry without dropping other providers", async () => {
    let written: string | null = null;
    const result = await hydratePiAnthropicFromClaude({
      agentDir: "/tmp/pi-agent",
      now: NOW,
      readClaudeTokens: async () => liveClaude(),
      readAuthFile: async () =>
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access: "old-access",
            refresh: "old-refresh",
            expires: NOW - 60_000,
          },
          "zai-coding-cn": { type: "key", key: "keep-me" },
        }),
      writeAuthFile: async (_path, contents) => {
        written = contents;
      },
    });

    expect(result).toBe("copied");
    const parsed = JSON.parse(written ?? "{}") as {
      anthropic: { access: string; refresh: string };
      "zai-coding-cn": { key: string };
    };
    expect(parsed.anthropic.access).toBe("claude-access");
    expect(parsed.anthropic.refresh).toBe("claude-refresh");
    expect(parsed["zai-coding-cn"].key).toBe("keep-me");
  });

  it("does not copy an already-expired Claude access token", async () => {
    let wrote = false;
    const result = await hydratePiAnthropicFromClaude({
      agentDir: "/tmp/pi-agent",
      now: NOW,
      readClaudeTokens: async () =>
        liveClaude({ expiresAt: NOW - 1_000 }),
      readAuthFile: async () => {
        throw new Error("should not read Pi auth");
      },
      writeAuthFile: async () => {
        wrote = true;
      },
    });

    expect(result).toBe("skipped");
    expect(wrote).toBe(false);
  });

  it("leaves Pi alone when it already matches a live Claude session", async () => {
    let wrote = false;
    const claude = liveClaude();
    const result = await hydratePiAnthropicFromClaude({
      agentDir: "/tmp/pi-agent",
      now: NOW,
      readClaudeTokens: async () => claude,
      readAuthFile: async () =>
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access: claude.accessToken,
            refresh: claude.refreshToken,
            expires: claude.expiresAt,
          },
        }),
      writeAuthFile: async () => {
        wrote = true;
      },
    });

    expect(result).toBe("unchanged");
    expect(wrote).toBe(false);
  });
});

describe("ensureClaudeOAuthFresh", () => {
  it("refreshes the newest expired session and writes every store", async () => {
    const written: ClaudeOAuthTokens[] = [];
    const result = await ensureClaudeOAuthFresh({
      agentDir: "/tmp/pi-agent-ensure",
      now: NOW,
      readCandidates: async () => [
        {
          source: "claude",
          tokens: liveClaude({
            accessToken: "old-access",
            refreshToken: "older-refresh",
            expiresAt: NOW - 120_000,
          }),
        },
      ],
      refreshTokens: async (refreshToken) => {
        expect(refreshToken).toBe("older-refresh");
        return liveClaude({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: NOW + 8 * 60 * 60 * 1000,
        });
      },
      writeStores: async (tokens) => {
        written.push(tokens);
      },
    });

    expect(result).toBe("refreshed");
    expect(written).toEqual([
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: NOW + 8 * 60 * 60 * 1000,
      },
    ]);
  });

  it("writes the NEWEST live token, never an older live one", async () => {
    // Regression: candidates are read keychain-before-file, so taking the
    // first live one let a stale keychain overwrite a freshly written
    // credentials file, destroying a just-completed login with a token the
    // server had already rotated dead.
    const written: ClaudeOAuthTokens[] = [];
    const result = await ensureClaudeOAuthFresh({
      agentDir: "/tmp/pi-agent-ensure",
      now: NOW,
      hydrate: async () => "unchanged" as const,
      readCandidates: async () => [
        {
          source: "claude",
          tokens: liveClaude({
            accessToken: "stale-but-live",
            refreshToken: "stale-refresh",
            expiresAt: NOW + 60 * 60 * 1000,
          }),
        },
        {
          source: "claude",
          tokens: liveClaude({
            accessToken: "freshly-logged-in",
            refreshToken: "fresh-refresh",
            expiresAt: NOW + 8 * 60 * 60 * 1000,
          }),
        },
      ],
      refreshTokens: async () => {
        throw new Error("must not refresh when a live token exists");
      },
      writeStores: async (tokens) => {
        written.push(tokens);
      },
    });

    expect(result).toBe("healed");
    expect(written).toHaveLength(1);
    expect(written[0]?.accessToken).toBe("freshly-logged-in");
  });

  it("does not write when every store already holds the same token", async () => {
    // A keychain rewritten by this process can lose the ACL the Claude CLI
    // needs to update it, so an agreeing set must be left alone.
    const written: ClaudeOAuthTokens[] = [];
    const shared = liveClaude({ accessToken: "same", refreshToken: "r" });
    const result = await ensureClaudeOAuthFresh({
      agentDir: "/tmp/pi-agent-ensure",
      now: NOW,
      hydrate: async () => "unchanged" as const,
      readCandidates: async () => [
        { source: "claude", tokens: shared },
        { source: "claude", tokens: shared },
      ],
      refreshTokens: async () => {
        throw new Error("must not refresh");
      },
      writeStores: async (tokens) => {
        written.push(tokens);
      },
    });
    expect(result).toBe("live");
    expect(written).toEqual([]);
  });

  it("heals a hollow store from a live one", async () => {
    const written: ClaudeOAuthTokens[] = [];
    const result = await ensureClaudeOAuthFresh({
      agentDir: "/tmp/pi-agent-ensure",
      now: NOW,
      hydrate: async () => "unchanged" as const,
      readCandidates: async () => [
        {
          source: "claude",
          tokens: liveClaude({
            accessToken: "dead",
            refreshToken: "",
            expiresAt: NOW - 60_000,
          }),
        },
        {
          source: "claude",
          tokens: liveClaude({ accessToken: "good", refreshToken: "r" }),
        },
      ],
      refreshTokens: async () => {
        throw new Error("must not refresh when a live token exists");
      },
      writeStores: async (tokens) => {
        written.push(tokens);
      },
    });
    expect(result).toBe("healed");
    expect(written[0]?.accessToken).toBe("good");
  });

  it("does not call refresh when a live access token already exists", async () => {
    let refreshed = false;
    const result = await ensureClaudeOAuthFresh({
      agentDir: "/tmp/pi-agent-ensure",
      now: NOW,
      readCandidates: async () => [{ source: "claude", tokens: liveClaude() }],
      refreshTokens: async () => {
        refreshed = true;
        return null;
      },
      writeStores: async () => {
        throw new Error("should not write");
      },
      hydrate: async () => "unchanged",
    });
    expect(result).toBe("live");
    expect(refreshed).toBe(false);
  });

  it("returns unauthenticated when every refresh fails", async () => {
    const result = await ensureClaudeOAuthFresh({
      agentDir: "/tmp/pi-agent-ensure",
      now: NOW,
      readCandidates: async () => [
        {
          source: "claude",
          tokens: liveClaude({ expiresAt: NOW - 1_000 }),
        },
      ],
      refreshTokens: async () => null,
      writeStores: async () => {
        throw new Error("should not write");
      },
    });
    expect(result).toBe("unauthenticated");
  });
});

describe("refreshClaudeOAuthTokens", () => {
  it("maps a token response onto Claude store fields", async () => {
    const tokens = await refreshClaudeOAuthTokens({
      refreshToken: "r1",
      now: NOW,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: "a2",
            refresh_token: "r2",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    });
    expect(tokens).toEqual({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: NOW + 3600_000,
    });
  });

  it("returns null on invalid_grant", async () => {
    const tokens = await refreshClaudeOAuthTokens({
      refreshToken: "dead",
      now: NOW,
      fetchImpl: async () => new Response("invalid_grant", { status: 400 }),
    });
    expect(tokens).toBeNull();
  });
});
