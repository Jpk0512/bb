import { describe, expect, it } from "vitest";
import {
  hydratePiAnthropicFromClaude,
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
