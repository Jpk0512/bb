import type { NotificationListResponse } from "@bb/server-contract";
import {
  notificationListQueryKey,
  sidebarNavigationQueryKey,
} from "../queries/query-keys";
import type { QueryClientArg } from "../cache-effect-types";

export interface DismissNotificationTransaction {
  previous: NotificationListResponse | undefined;
}

interface NotificationArgs extends QueryClientArg {
  notificationId: string;
}

interface RollbackDismissNotificationArgs extends QueryClientArg {
  transaction: DismissNotificationTransaction | undefined;
}

function withoutNotification(
  current: NotificationListResponse,
  notificationId: string,
): NotificationListResponse {
  const dismissed = current.notifications.find(
    (notification) => notification.id === notificationId,
  );
  return {
    notifications: current.notifications.filter(
      (notification) => notification.id !== notificationId,
    ),
    unreadCount: Math.max(
      0,
      current.unreadCount - (dismissed?.readAt === null ? 1 : 0),
    ),
  };
}

function withNotificationRead(
  current: NotificationListResponse,
  notificationId: string,
  readAt: number,
): NotificationListResponse {
  return {
    notifications: current.notifications.map((notification) =>
      notification.id === notificationId
        ? { ...notification, readAt }
        : notification,
    ),
    unreadCount: Math.max(0, current.unreadCount - 1),
  };
}

function isUnread(
  current: NotificationListResponse,
  notificationId: string,
): boolean {
  return current.notifications.some(
    (candidate) => candidate.id === notificationId && candidate.readAt === null,
  );
}

export async function beginDismissNotificationTransaction({
  notificationId,
  queryClient,
}: NotificationArgs): Promise<DismissNotificationTransaction> {
  const queryKey = notificationListQueryKey();
  await queryClient.cancelQueries({ queryKey });
  const previous = queryClient.getQueryData<NotificationListResponse>(queryKey);
  if (previous !== undefined) {
    queryClient.setQueryData<NotificationListResponse>(
      queryKey,
      withoutNotification(previous, notificationId),
    );
  }
  return { previous };
}

export function rollbackDismissNotificationTransaction({
  queryClient,
  transaction,
}: RollbackDismissNotificationArgs): void {
  if (transaction?.previous === undefined) {
    return;
  }
  queryClient.setQueryData<NotificationListResponse>(
    notificationListQueryKey(),
    transaction.previous,
  );
}

/**
 * Mark one notification read in place. The server already did it as part of
 * opening the target, so this only keeps the badge from lagging a refetch.
 */
export function applyNotificationOpenResult({
  notificationId,
  queryClient,
}: NotificationArgs): void {
  const readAt = Date.now();
  queryClient.setQueryData<NotificationListResponse>(
    notificationListQueryKey(),
    (current) => {
      if (!current || !isUnread(current, notificationId)) {
        return current;
      }
      return withNotificationRead(current, notificationId, readAt);
    },
  );
}

export async function invalidateNotificationSurfaces({
  queryClient,
}: QueryClientArg): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: notificationListQueryKey() }),
    // Notification counts are projected into the sidebar bootstrap's thread rows.
    queryClient.invalidateQueries({ queryKey: sidebarNavigationQueryKey() }),
  ]);
}
