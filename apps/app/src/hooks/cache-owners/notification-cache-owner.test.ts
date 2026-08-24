import { describe, expect, it } from "vitest";
import type { Notification } from "@bb/domain";
import type { NotificationListResponse } from "@bb/server-contract";
import { createAppQueryClient } from "@/lib/query-client";
import { notificationListQueryKey } from "../queries/query-keys";
import {
  applyNotificationOpenResult,
  beginDismissNotificationTransaction,
  rollbackDismissNotificationTransaction,
} from "./notification-cache-owner";

function createNotification(id: string, readAt: number | null): Notification {
  return {
    id,
    threadId: "thr_1",
    projectId: "proj_1",
    sourceKind: "plugin",
    pluginId: "tasks",
    category: "review-ready",
    title: `Notification ${id}`,
    body: null,
    payload: null,
    rendererId: null,
    dedupeKey: null,
    attention: false,
    createdAt: 1000,
    readAt,
    dismissedAt: null,
    target: null,
  };
}

function createQueryClient() {
  return createAppQueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    showMutationErrorToasts: false,
  });
}

function readList(
  queryClient: ReturnType<typeof createQueryClient>,
): NotificationListResponse | undefined {
  return queryClient.getQueryData<NotificationListResponse>(
    notificationListQueryKey(),
  );
}

describe("notification cache owner", () => {
  it("drops the dismissed row and only decrements the count for an unread one", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<NotificationListResponse>(
      notificationListQueryKey(),
      {
        notifications: [
          createNotification("ntf_unread", null),
          createNotification("ntf_read", 2000),
        ],
        unreadCount: 1,
      },
    );

    await beginDismissNotificationTransaction({
      notificationId: "ntf_read",
      queryClient,
    });

    expect(readList(queryClient)).toEqual({
      notifications: [createNotification("ntf_unread", null)],
      unreadCount: 1,
    });

    const transaction = await beginDismissNotificationTransaction({
      notificationId: "ntf_unread",
      queryClient,
    });

    expect(readList(queryClient)).toEqual({
      notifications: [],
      unreadCount: 0,
    });

    rollbackDismissNotificationTransaction({ queryClient, transaction });

    expect(readList(queryClient)).toEqual({
      notifications: [createNotification("ntf_unread", null)],
      unreadCount: 1,
    });
  });

  it("leaves the count alone when the opened notification was already read", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<NotificationListResponse>(
      notificationListQueryKey(),
      {
        notifications: [createNotification("ntf_read", 2000)],
        unreadCount: 3,
      },
    );

    applyNotificationOpenResult({
      notificationId: "ntf_read",
      queryClient,
    });

    expect(readList(queryClient)).toEqual({
      notifications: [createNotification("ntf_read", 2000)],
      unreadCount: 3,
    });
  });
});
