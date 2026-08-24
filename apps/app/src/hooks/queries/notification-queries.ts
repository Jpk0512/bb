import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Notification } from "@bb/domain";
import type { NotificationOpenResponse } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import {
  applyNotificationOpenResult,
  beginDismissNotificationTransaction,
  invalidateNotificationSurfaces,
  rollbackDismissNotificationTransaction,
  type DismissNotificationTransaction,
} from "../cache-owners/notification-cache-owner";
import { notificationListQueryKey } from "./query-keys";

export function useNotificationList() {
  return useQuery({
    queryKey: notificationListQueryKey(),
    queryFn: ({ signal }) => sdk.notifications.list({ state: "open", signal }),
    staleTime: 0,
  });
}

export function useDismissNotification() {
  const queryClient = useQueryClient();
  return useMutation<
    Notification,
    Error,
    string,
    DismissNotificationTransaction
  >({
    meta: { errorMessage: "Unable to dismiss notification." },
    mutationFn: (notificationId) =>
      sdk.notifications.dismiss({ notificationId }),
    onMutate: (notificationId) =>
      beginDismissNotificationTransaction({ notificationId, queryClient }),
    onError: (_error, _notificationId, transaction) => {
      rollbackDismissNotificationTransaction({ queryClient, transaction });
    },
    onSettled: () => invalidateNotificationSurfaces({ queryClient }),
  });
}

export function useOpenNotification() {
  const queryClient = useQueryClient();
  return useMutation<NotificationOpenResponse, Error, string>({
    meta: { errorMessage: "Unable to open notification target." },
    mutationFn: (notificationId) => sdk.notifications.open({ notificationId }),
    onSuccess: (result, notificationId) => {
      if (result.outcome === "target-missing") return;
      applyNotificationOpenResult({ notificationId, queryClient });
    },
    onSettled: () => invalidateNotificationSurfaces({ queryClient }),
  });
}
