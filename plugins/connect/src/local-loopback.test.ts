import { describe, expect, it } from "vitest";
import { resolveLocalCloudLoopbackUrl } from "./local-loopback.js";

describe("resolveLocalCloudLoopbackUrl", () => {
  it("targets Vite for local source-development pairings", () => {
    expect(
      resolveLocalCloudLoopbackUrl("http://sawyer.localhost:8787", "11001"),
    ).toBe("http://127.0.0.1:11001");
    expect(
      resolveLocalCloudLoopbackUrl("http://sawyer.localhost:8787", undefined),
    ).toBeNull();
  });

  it("targets Vite for a production getbb.app pairing while pnpm dev is running", () => {
    expect(
      resolveLocalCloudLoopbackUrl("https://sawyer.getbb.app", "11001"),
    ).toBe("http://127.0.0.1:11001");
    expect(resolveLocalCloudLoopbackUrl("https://getbb.app", "11001")).toBe(
      "http://127.0.0.1:11001",
    );
  });

  it("does not rewrite unknown hosts or packaged servers without a Vite port", () => {
    expect(
      resolveLocalCloudLoopbackUrl("https://sawyer.example.com", "11001"),
    ).toBeNull();
    expect(
      resolveLocalCloudLoopbackUrl("https://sawyer.getbb.app", undefined),
    ).toBeNull();
  });
});
