import type { QueryKey } from "@tanstack/react-query";
import {
  allEnvironmentDiffFilesQueryKeyPrefix,
  allEnvironmentDiffPatchQueryKeyPrefix,
  allEnvironmentFilePreviewQueryKeyPrefix,
  allEnvironmentMergeBaseBranchesQueryKeyPrefix,
  allEnvironmentQueryKeyPrefix,
  allEnvironmentWorkStatusQueryKeyPrefix,
  allHostQueryKeyPrefix,
  allNotificationListQueryKeyPrefix,
  allProjectPathsQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  allThreadConversationOutlineQueryKeyPrefix,
  allThreadDetailBootstrapQueryKeyPrefix,
  allThreadHostFilePreviewQueryKeyPrefix,
  allThreadPendingInteractionsQueryKeyPrefix,
  allThreadQueuedMessagesQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageLocationsQueryKeyPrefix,
  allThreadStoragePathsQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  allThreadTimelineTurnSummaryDetailsQueryKeyPrefix,
  allThreadTurnsQueryKeyPrefix,
  hostPathExistenceQueryKeyPrefix,
  hostsQueryKey,
  projectsQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  systemDisabledModelsQueryKey,
  threadPromptHistoryQueryKeyPrefix,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { allThreadDefaultExecutionOptionsQueryKeyPrefix } from "../queries/thread-default-execution-options-query";
import type { QueryClientArg, QueryKeysArg } from "../cache-effect-types";
import { clearCachedModelCatalogs } from "@/lib/model-catalog-cache";
import { bumpAllDiffPatchEvictionGenerations } from "./environment-diff-patch-cache-owner";
import { invalidateSystemVersion } from "./system-version-cache-owner";
import {
  invalidateQueryKeys,
  refetchFailedActiveQueryKeys,
} from "./cache-effect-utils";

interface SystemExecutionOptionsInvalidationArgs extends QueryClientArg {
  hostId: string;
}

interface ServerReconnectInvalidationArgs extends QueryClientArg {
  /**
   * Last moment the previous socket was known healthy. Data that resolved
   * after it observed server state the socket could not have missed, so it is
   * left alone; everything older (including never-loaded and errored queries,
   * whose `dataUpdatedAt` is 0) is refetched.
   */
  disconnectedAt: number;
}

/**
 * Reconnect catch-up. Mirrors the initial-connect watermark rather than a
 * blanket invalidation: on a phone every app switch reconnects the socket
 * while focus refetches and the flush of changes merged while hidden are
 * already loading the visible thread. A blanket invalidate with the default
 * `cancelRefetch: true` would abort those partially downloaded responses and
 * start every one over.
 */
export function invalidateRealtimeQueriesAfterServerReconnect({
  disconnectedAt,
  queryClient,
}: ServerReconnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    void queryClient.invalidateQueries(
      {
        queryKey,
        predicate: (query) => query.state.dataUpdatedAt < disconnectedAt,
      },
      // A fetch already in flight resolves to post-reconnect data; keep it.
      { cancelRefetch: false },
    );
  }
  // A reconnect is how the app learns the server restarted, which is exactly
  // what a bb self-update does — so re-check the version rather than keep
  // advertising the update the user just applied.
  invalidateSystemVersion({ queryClient });
  // The per-file diff patch cache is observer-less: invalidation only marks it
  // stale and never refetches or evicts, so a reconnect must remove it. The
  // diff TOC refetch (invalidated above) then drives the panel to re-request
  // and repopulate the visible patches.
  //
  // Bump every environment's eviction generation synchronously so a patch fetch
  // that was in flight across the reconnect drops its now-stale write instead
  // of re-seeding the just-cleared cache.
  bumpAllDiffPatchEvictionGenerations();
  queryClient.removeQueries({
    queryKey: allEnvironmentDiffPatchQueryKeyPrefix(),
  });
}

/**
 * Retry realtime-owned queries that have never succeeded, once realtime
 * connectivity is established.
 *
 * `refetchFailedActiveQueryKeys` can only act on a query that has already
 * settled, and the first-load window is exactly when that is not true: the
 * socket opens in a few ms while the bootstrap HTTP requests are still in
 * flight, so a request that fails a moment later is invisible to the first
 * pass. With `staleTime: Infinity` on those queries nothing else ever retries
 * them. Awaiting the in-flight first loads and running one more pass is what
 * closes that window.
 *
 * Bounded to those two passes per call: a query that keeps failing is left in
 * its error state for the UI to surface rather than retried in a loop.
 */
export async function recoverErroredRealtimeQueries({
  queryClient,
}: QueryClientArg): Promise<void> {
  const queryKeys = getServerReconnectInvalidationQueryKeys();
  refetchFailedActiveQueryKeys({ queryClient, queryKeys });
  const inFlightFirstLoads = collectInFlightFirstLoads({
    queryClient,
    queryKeys,
  });
  if (inFlightFirstLoads.length === 0) {
    return;
  }
  await Promise.allSettled(inFlightFirstLoads);
  refetchFailedActiveQueryKeys({ queryClient, queryKeys });
}

function collectInFlightFirstLoads({
  queryClient,
  queryKeys,
}: QueryKeysArg): Promise<unknown>[] {
  const promises = new Set<Promise<unknown>>();
  for (const queryKey of queryKeys) {
    for (const query of queryClient.getQueryCache().findAll({
      queryKey,
      type: "active",
      predicate: (candidate) =>
        candidate.state.dataUpdatedAt === 0 &&
        candidate.state.fetchStatus === "fetching",
    })) {
      if (query.promise) {
        promises.add(query.promise);
      }
    }
  }
  return [...promises];
}

interface InitialConnectInvalidationArgs extends QueryClientArg {
  /** Timestamp at which the realtime subscriptions became active. */
  connectedAt: number;
}

/**
 * A query that resolved before the realtime subscriptions were active may have
 * missed change events published in between, and nothing later corrects it:
 * the initial-connect path never fires again and staleTime defers mount/focus
 * refetches. On desktop cold start this window is real — the host daemon opens
 * its session a few hundred ms after the server starts listening, so the first
 * hosts/providers fetches capture "disconnected" and the `host-connected`
 * broadcast lands before the app's subscription registers. Invalidate any
 * realtime query whose data predates the subscription watermark; queries that
 * resolve after it observe post-subscribe server state and stay untouched.
 */
export function invalidateRealtimeQueriesFetchedBeforeInitialConnect({
  connectedAt,
  queryClient,
}: InitialConnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    queryClient.invalidateQueries({
      queryKey,
      predicate: (query) =>
        query.state.dataUpdatedAt !== 0 &&
        query.state.dataUpdatedAt < connectedAt,
    });
  }
}

/**
 * Refresh `/system/config` after an experiments write: the server broadcast
 * covers other windows, this gives the writing window an immediate re-gate.
 */
export function invalidateSystemConfig({ queryClient }: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: systemConfigQueryKey() });
}

/** Refresh the provider directory after its effective order can change. */
export function invalidateSystemProviders({
  queryClient,
}: QueryClientArg): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allSystemProvidersQueryKeyPrefix(),
  });
}

/** Refresh provider/model catalogs after a provider CLI install or update. */
export function invalidateSystemExecutionOptions({
  hostId,
  queryClient,
}: SystemExecutionOptionsInvalidationArgs): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
    predicate: (query) =>
      query.queryKey[2] === hostId || query.queryKey[2] === null,
  });
}

/**
 * Refresh every cached provider/model catalog plus the curation list itself
 * after a disabled-models write. Unlike a provider CLI install, curation is
 * host-independent, so every cached execution-options entry is stale.
 */
export function invalidateDisabledModels({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: systemDisabledModelsQueryKey() });
  queryClient.invalidateQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
  });
}

/** Refresh settings and timeline projections after a General settings write. */
export function invalidateGeneralSettingsDependencies({
  queryClient,
}: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [
      systemConfigQueryKey(),
      allThreadTimelineQueryKeyPrefix(),
      allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    ],
  });
}

/**
 * Forget every model catalog after streamer mode flips. An invalidation would
 * keep showing the previous catalog, and the localStorage preload would replay
 * it on the next mount, until a refetch succeeds; both can still name a model
 * the server now hides. A reset drops the data first, so open pickers show a
 * loading state and refetch instead of the stale list.
 */
export function resetModelCatalogsAfterStreamerModeChange({
  queryClient,
}: QueryClientArg): Promise<void> {
  clearCachedModelCatalogs();
  return queryClient.resetQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
  });
}

function getServerReconnectInvalidationQueryKeys(): QueryKey[] {
  return [
    hostsQueryKey(),
    allHostQueryKeyPrefix(),
    projectsQueryKey(),
    sidebarNavigationQueryKey(),
    allProjectPathsQueryKeyPrefix(),
    threadsQueryKey(),
    threadSearchQueryKeyPrefix(),
    allThreadQueryKeyPrefix(),
    allThreadDetailBootstrapQueryKeyPrefix(),
    allThreadTimelineQueryKeyPrefix(),
    allThreadConversationOutlineQueryKeyPrefix(),
    allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    // Turn telemetry is realtime-owned with staleTime Infinity, so a strip whose
    // events landed during the disconnect stays empty until a full reload.
    allThreadTurnsQueryKeyPrefix(),
    allThreadQueuedMessagesQueryKeyPrefix(),
    threadPromptHistoryQueryKeyPrefix(),
    allThreadPendingInteractionsQueryKeyPrefix(),
    allThreadDefaultExecutionOptionsQueryKeyPrefix(),
    allThreadStorageFilesQueryKeyPrefix(),
    allThreadStorageLocationsQueryKeyPrefix(),
    allThreadStoragePathsQueryKeyPrefix(),
    allThreadStorageFilePreviewQueryKeyPrefix(),
    allThreadHostFilePreviewQueryKeyPrefix(),
    allTerminalsQueryKeyPrefix(),
    allEnvironmentQueryKeyPrefix(),
    allEnvironmentWorkStatusQueryKeyPrefix(),
    allEnvironmentMergeBaseBranchesQueryKeyPrefix(),
    // The diff TOC has a real observer, so it refetches on invalidate. The
    // per-file patch cache is observer-less and is evicted separately in
    // invalidateRealtimeQueriesAfterServerReconnect (invalidation is a no-op for
    // it), so it is intentionally absent from this list.
    allEnvironmentDiffFilesQueryKeyPrefix(),
    allEnvironmentFilePreviewQueryKeyPrefix(),
    hostPathExistenceQueryKeyPrefix(),
    allSystemProvidersQueryKeyPrefix(),
    allSystemExecutionOptionsQueryKeyPrefix(),
    allNotificationListQueryKeyPrefix(),
  ];
}
