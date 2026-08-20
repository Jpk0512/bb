import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Notification } from "@bb/domain";
import type { NotificationOpenResponse } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import {
  notificationListQueryKey,
  sidebarNavigationQueryKey,
} from "./query-keys";

export function useNotificationList() {
  return useQuery({
    queryKey: notificationListQueryKey(),
    queryFn: ({ signal }) => sdk.notifications.list({ state: "open", signal }),
    staleTime: 0,
  });
}

function invalidateNotificationSurfaces(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: notificationListQueryKey() }),
    // Notification counts are projected into the sidebar bootstrap's thread rows.
    queryClient.invalidateQueries({ queryKey: sidebarNavigationQueryKey() }),
  ]);
}

export function useDismissNotification() {
  const queryClient = useQueryClient();
  return useMutation<
    Notification,
    Error,
    string,
    { notifications: Notification[]; unreadCount: number } | undefined
  >({
    meta: { errorMessage: "Unable to dismiss notification." },
    mutationFn: (notificationId) =>
      sdk.notifications.dismiss({ notificationId }),
    onMutate: async (notificationId) => {
      await queryClient.cancelQueries({ queryKey: notificationListQueryKey() });
      const previous = queryClient.getQueryData<{
        notifications: Notification[];
        unreadCount: number;
      }>(notificationListQueryKey());
      if (previous) {
        queryClient.setQueryData(notificationListQueryKey(), {
          notifications: previous.notifications.filter(
            (notification) => notification.id !== notificationId,
          ),
          unreadCount: Math.max(
            0,
            previous.unreadCount -
              (previous.notifications.find(
                (notification) => notification.id === notificationId,
              )?.readAt === null
                ? 1
                : 0),
          ),
        });
      }
      return previous;
    },
    onError: (_error, _notificationId, previous) => {
      if (previous)
        queryClient.setQueryData(notificationListQueryKey(), previous);
    },
    onSettled: () => invalidateNotificationSurfaces(queryClient),
  });
}

export function useOpenNotification() {
  const queryClient = useQueryClient();
  return useMutation<NotificationOpenResponse, Error, string>({
    meta: { errorMessage: "Unable to open notification target." },
    mutationFn: (notificationId) => sdk.notifications.open({ notificationId }),
    onSuccess: (result, notificationId) => {
      if (result.outcome === "target-missing") return;
      queryClient.setQueryData<{
        notifications: Notification[];
        unreadCount: number;
      }>(notificationListQueryKey(), (current) => {
        if (!current) return current;
        const notification = current.notifications.find(
          (candidate) => candidate.id === notificationId,
        );
        if (!notification || notification.readAt !== null) return current;
        return {
          notifications: current.notifications.map((candidate) =>
            candidate.id === notificationId
              ? { ...candidate, readAt: Date.now() }
              : candidate,
          ),
          unreadCount: Math.max(0, current.unreadCount - 1),
        };
      });
    },
    onSettled: () => invalidateNotificationSurfaces(queryClient),
  });
}
