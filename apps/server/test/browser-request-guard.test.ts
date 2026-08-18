import { describe, expect, it } from "vitest";
import { browserRequestProblem } from "../src/browser-request-guard.js";

const SERVER_PORT = 23_539;
const DEV_APP_PORT = 5_191;

function guardDeps(additionalAppOrigins?: readonly string[]) {
  const config = {
    serverPort: SERVER_PORT,
    devAppPort: DEV_APP_PORT,
    ...(additionalAppOrigins === undefined ? {} : { additionalAppOrigins }),
  };
  return { config } as Parameters<typeof browserRequestProblem>[1];
}

function request(headers: Record<string, string>) {
  const lowercased = new Map(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  return {
    req: {
      url: `http://127.0.0.1:${SERVER_PORT}/api/v1/marketplaces/refresh`,
      method: "POST",
      header: (name: string) => lowercased.get(name.toLowerCase()),
    },
  };
}

describe("browserRequestProblem", () => {
  it("allows the dev app origin", () => {
    const problem = browserRequestProblem(
      request({ origin: `http://localhost:${DEV_APP_PORT}` }),
      guardDeps(),
    );

    expect(problem).toBeNull();
  });

  it("allows a request with no Origin at all (CLI and SDK callers)", () => {
    expect(browserRequestProblem(request({}), guardDeps())).toBeNull();
  });

  it("rejects a foreign origin", () => {
    const problem = browserRequestProblem(
      request({ origin: "https://evil.example.com" }),
      guardDeps(),
    );

    expect(problem?.status).toBe(403);
  });

  // A reverse proxy on 443 forwards the browser's origin, so the guard has to
  // reconstruct it from the forwarding headers. If the proxy reports its own
  // scheme instead of the client's, the reconstructed origin is http:// and no
  // longer matches, which is what broke bb.local behind OrbStack.
  it("trusts a proxied origin when the forwarded scheme and host match", () => {
    const problem = browserRequestProblem(
      request({
        origin: "https://bb.local",
        host: `127.0.0.1:${SERVER_PORT}`,
        "x-forwarded-host": "bb.local",
        "x-forwarded-proto": "https,http",
      }),
      guardDeps(),
    );

    expect(problem).toBeNull();
  });

  it("rejects a proxied origin when the forwarded scheme disagrees", () => {
    const problem = browserRequestProblem(
      request({
        origin: "https://bb.local",
        host: `127.0.0.1:${SERVER_PORT}`,
        "x-forwarded-host": "bb.local",
        "x-forwarded-proto": "http",
      }),
      guardDeps(),
    );

    expect(problem?.status).toBe(403);
  });

  // Requests the browser sends straight to a local port carry no forwarding
  // headers, so a configured proxy origin is the only way to admit them.
  it("allows a configured additional origin with no forwarding headers", () => {
    const problem = browserRequestProblem(
      request({ origin: "https://bb.local" }),
      guardDeps(["https://bb.local"]),
    );

    expect(problem).toBeNull();
  });

  it("still rejects origins outside the configured list", () => {
    const problem = browserRequestProblem(
      request({ origin: "https://other.local" }),
      guardDeps(["https://bb.local"]),
    );

    expect(problem?.status).toBe(403);
  });

  it("requires JSON for mutations when asked", () => {
    const problem = browserRequestProblem(
      request({ origin: `http://localhost:${DEV_APP_PORT}` }),
      guardDeps(),
      { requireJsonForMutation: true },
    );

    expect(problem?.status).toBe(415);
  });
});
