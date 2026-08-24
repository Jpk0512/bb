import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRetryingModuleLoader } from "./plugin-frontend-lazy";

const runtime = vi.hoisted(() => ({
  boot: vi.fn<() => Promise<void>>(),
  schedule: vi.fn<() => void>(),
}));

vi.mock("./plugin-frontend", () => ({
  bootPluginFrontends: () => runtime.boot(),
  schedulePluginFrontendReconcile: () => {
    runtime.schedule();
  },
}));

describe("createRetryingModuleLoader", () => {
  it("refetches after a rejection instead of replaying it", async () => {
    // The plugin runtime lives in a lazily fetched chunk. A caching loader
    // that kept the rejected promise would leave plugin UI dead for the rest
    // of the page's life after one flaky chunk fetch.
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("chunk fetch failed"))
      .mockResolvedValue("module");
    const loader = createRetryingModuleLoader(load);

    await expect(loader()).rejects.toThrow("chunk fetch failed");
    await expect(loader()).resolves.toBe("module");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads once and shares the result across concurrent callers", async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValue("module");
    const loader = createRetryingModuleLoader(load);

    const [first, second] = await Promise.all([loader(), loader()]);

    expect(first).toBe("module");
    expect(second).toBe("module");
    // Boot and a realtime reconcile can race on the first page load; the
    // chunk must not be fetched twice.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the loaded module without refetching", async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValue("module");
    const loader = createRetryingModuleLoader(load);

    await loader();
    await loader();

    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("plugin runtime fault isolation", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  // Module-level state (boot latch, reported-failure memo) has to be fresh per
  // case, so each test imports its own copy of the lazy door.
  const importLazyDoor = async () => {
    vi.resetModules();
    return import("./plugin-frontend-lazy");
  };

  beforeEach(() => {
    runtime.boot.mockReset();
    runtime.schedule.mockReset();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("reports a runtime boot failure and still reconciles the other plugins", async () => {
    // A third-party bundle throwing during its own registration used to escape
    // as an unhandled rejection on the app root and skip the reconcile.
    const pluginError = new Error(
      'No valid theme loader registered for "bb:plugin:monokai:bb-monokai:dark:d72e36a9"',
    );
    runtime.boot.mockRejectedValue(pluginError);
    const lazyDoor = await importLazyDoor();

    await expect(lazyDoor.bootPluginFrontends()).resolves.toBeUndefined();
    lazyDoor.schedulePluginFrontendReconcile();
    await vi.waitFor(() => {
      expect(runtime.schedule).toHaveBeenCalledTimes(1);
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("bb:plugin:monokai");
  });

  it("reports a throwing reconcile scheduler instead of leaving it unhandled", async () => {
    runtime.boot.mockResolvedValue(undefined);
    runtime.schedule.mockImplementation(() => {
      throw new Error("scheduler blew up");
    });
    const lazyDoor = await importLazyDoor();

    await lazyDoor.bootPluginFrontends();
    lazyDoor.schedulePluginFrontendReconcile();

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("scheduler blew up"),
      );
    });
  });

  it("stays quiet on a reconcile before anything booted", async () => {
    const lazyDoor = await importLazyDoor();

    lazyDoor.schedulePluginFrontendReconcile();
    await Promise.resolve();

    expect(runtime.boot).not.toHaveBeenCalled();
    expect(runtime.schedule).not.toHaveBeenCalled();
  });
});
