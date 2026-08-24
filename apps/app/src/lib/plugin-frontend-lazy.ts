/**
 * The boot-path-safe door into `plugin-frontend`.
 *
 * `plugin-frontend` holds the plugin runtime shim (plugin design §5.1): it
 * imports every library a plugin may resolve at runtime — React, the portal
 * Radix families, sonner, vaul, `@pierre/diffs` (and Shiki behind it) — plus
 * `plugin-sdk-app-impl`, which reaches the promptbox editor and the markdown
 * renderer. Statically importing it from `App` put roughly 1.9 MB of
 * JavaScript in front of first paint even when the page had no plugins.
 *
 * Nothing here may import `plugin-frontend` statically. Routes that render
 * plugin management UI are already lazy and import it directly; they share
 * this module instance, so the reconcile state stays single-owner.
 */
type PluginFrontendModule = typeof import("./plugin-frontend");

/**
 * Caches a module import, but drops the cache when the import rejects.
 *
 * A chunk fetch fails on a flaky network. Caching the rejected promise would
 * replay that one failure for the rest of the page's life, so plugin UI could
 * never come back without a reload.
 */
export function createRetryingModuleLoader<T>(
  load: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

const loadPluginFrontend = createRetryingModuleLoader<PluginFrontendModule>(
  () => import("./plugin-frontend"),
);

let bootRequested = false;
const reportedFailures = new Set<string>();

/**
 * Records a plugin runtime failure instead of letting it escape.
 *
 * Never silent: a broken third-party bundle is only diagnosable from what it
 * threw, so the message is carried through verbatim. Deduplicated for the
 * page's life, because a `plugins-changed` storm against the same broken
 * bundle would otherwise repeat one line until it drowns everything else.
 */
function reportPluginRuntimeFailure(
  phase: "load" | "boot" | "reconcile",
  error: unknown,
): void {
  const message = `plugin runtime ${phase} failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (reportedFailures.has(message)) return;
  reportedFailures.add(message);
  console.warn(message);
}

/**
 * Loads the plugin runtime chunk, then boots the plugin frontends.
 *
 * Matches `bootPluginFrontends`' own contract that a plugin failure leaves the
 * app unharmed. The chunk fetch is the one step that module cannot guard for
 * itself, and callers boot this from an effect without awaiting it, so an
 * escaping rejection would surface as an unhandled one.
 */
export async function bootPluginFrontends(): Promise<void> {
  bootRequested = true;
  let pluginFrontend: PluginFrontendModule;
  try {
    pluginFrontend = await loadPluginFrontend();
  } catch (error) {
    reportPluginRuntimeFailure("load", error);
    return;
  }
  try {
    await pluginFrontend.bootPluginFrontends();
  } catch (error) {
    reportPluginRuntimeFailure("boot", error);
  }
}

/**
 * Realtime `plugins-changed` hook. Broadcasts arrive on every page, so the
 * guard keeps the first one from pulling the runtime chunk onto the critical
 * path before anything asked for plugins.
 */
export function schedulePluginFrontendReconcile(): void {
  if (!bootRequested) return;
  void (async () => {
    let pluginFrontend: PluginFrontendModule;
    try {
      pluginFrontend = await loadPluginFrontend();
    } catch (error) {
      // Plugin UI stays absent until the next plugins-changed broadcast.
      reportPluginRuntimeFailure("load", error);
      return;
    }
    try {
      // If the chunk fetch failed during boot then plugin-frontend never
      // booted, and its own reconcile guard would no-op forever. Booting here
      // recovers from that; it costs nothing once booted, because
      // bootPluginFrontends is idempotent per page load.
      await pluginFrontend.bootPluginFrontends();
    } catch (error) {
      // Deliberately falls through to the reconcile below: one plugin that
      // fails during boot must not cost every other plugin its reconcile.
      reportPluginRuntimeFailure("boot", error);
    }
    try {
      pluginFrontend.schedulePluginFrontendReconcile();
    } catch (error) {
      reportPluginRuntimeFailure("reconcile", error);
    }
  })();
}
