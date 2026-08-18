import { describe, expect, it } from "vitest";
import { buildLocalAppOrigins } from "../src/local-app-origins.js";
import { validateOriginList } from "../src/public-url.js";

describe("buildLocalAppOrigins", () => {
  it("emits localhost and loopback variants for every known port", () => {
    expect(buildLocalAppOrigins({ serverPort: 19_000, devAppPort: 11_000 }))
      .toEqual([
        "http://127.0.0.1:19000",
        "http://127.0.0.1:11000",
        "http://localhost:19000",
        "http://localhost:11000",
      ]);
  });

  it("adds proxy origins without needing an app URL", () => {
    const origins = buildLocalAppOrigins({
      serverPort: 19_000,
      additionalOrigins: ["https://bb.local", "http://bb.local"],
    });

    expect(origins).toContain("https://bb.local");
    expect(origins).toContain("http://bb.local");
  });

  it("keeps additional origins independent of the advertised app URL", () => {
    const origins = buildLocalAppOrigins({
      serverPort: 19_000,
      appUrl: "https://app.example.com",
      additionalOrigins: ["https://bb.local"],
    });

    expect(origins).toContain("https://app.example.com");
    expect(origins).toContain("https://bb.local");
  });

  it("skips a malformed additional origin rather than refusing to start", () => {
    const origins = buildLocalAppOrigins({
      serverPort: 19_000,
      additionalOrigins: ["not a url", "https://bb.local"],
    });

    expect(origins).toContain("https://bb.local");
    expect(origins).not.toContain("not a url");
  });
});

describe("validateOriginList", () => {
  it("parses a comma-separated list into deduplicated origins", () => {
    expect(
      validateOriginList("BB_ADDITIONAL_APP_ORIGINS", " https://bb.local , http://bb.local ,https://bb.local"),
    ).toEqual(["https://bb.local", "http://bb.local"]);
  });

  it("treats an empty value as no origins", () => {
    expect(validateOriginList("BB_ADDITIONAL_APP_ORIGINS", "")).toEqual([]);
  });

  it("keeps an explicit non-default port", () => {
    expect(
      validateOriginList("BB_ADDITIONAL_APP_ORIGINS", "http://bb.local:8080"),
    ).toEqual(["http://bb.local:8080"]);
  });

  it("rejects an entry that is not a URL", () => {
    expect(() =>
      validateOriginList("BB_ADDITIONAL_APP_ORIGINS", "bb.local"),
    ).toThrow("BB_ADDITIONAL_APP_ORIGINS entries must be valid URLs");
  });

  it("rejects a non-http scheme", () => {
    expect(() =>
      validateOriginList("BB_ADDITIONAL_APP_ORIGINS", "ws://bb.local"),
    ).toThrow("BB_ADDITIONAL_APP_ORIGINS entries must be http or https");
  });

  // An allowlist entry that silently means something broader than it says is a
  // security defect, so anything carrying a path or credentials is refused.
  it("rejects entries that carry more than an origin", () => {
    for (const value of [
      "https://bb.local/admin",
      "https://user:pass@bb.local",
      "https://bb.local?x=1",
    ]) {
      expect(() =>
        validateOriginList("BB_ADDITIONAL_APP_ORIGINS", value),
      ).toThrow("BB_ADDITIONAL_APP_ORIGINS entries must be bare origins");
    }
  });

  it("accepts a single trailing slash", () => {
    expect(
      validateOriginList("BB_ADDITIONAL_APP_ORIGINS", "https://bb.local/"),
    ).toEqual(["https://bb.local"]);
  });
});
