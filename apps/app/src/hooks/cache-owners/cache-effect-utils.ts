import type { QueryKeysArg } from "../cache-effect-types";

export function invalidateQueryKeys({
  queryClient,
  queryKeys,
}: QueryKeysArg): void {
  for (const queryKey of queryKeys) {
    queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Retry the already-failed queries under these keys.
 *
 * `fetchStatus === "idle"` keeps this off a query that is still fetching, whose
 * outcome is not known yet — retrying one would only duplicate the request in
 * flight. Callers that also have to cover a fetch which fails *after* this pass
 * (see recoverErroredRealtimeQueries) run it again once those settle.
 */
export function refetchFailedActiveQueryKeys({
  queryClient,
  queryKeys,
}: QueryKeysArg): void {
  for (const queryKey of queryKeys) {
    void queryClient
      .refetchQueries({
        queryKey,
        type: "active",
        predicate: (query) =>
          query.state.status === "error" && query.state.fetchStatus === "idle",
      })
      .catch(() => {
        // Individual query state already captures the refetch error.
      });
  }
}
