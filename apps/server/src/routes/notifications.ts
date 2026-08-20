import {
  countUnreadNotifications,
  createNotification,
  dismissNotification,
  getNotification,
  getNotificationWithTarget,
  listNotifications,
  markNotificationRead,
  revealThread,
} from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { toNotification } from "../services/notifications/notification-serialization.js";
import { resolveNotificationTargetThread } from "../services/notifications/notification-target.js";

function requireNotificationWithTarget(deps: AppDeps, id: string) {
  const notification = getNotificationWithTarget(deps.db, id);
  if (!notification) {
    throw new ApiError(404, "notification_not_found", "Notification not found");
  }
  return notification;
}

export function registerNotificationRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.notifications;

  post(routes.create, (context, payload) => {
    const result = createNotification(deps.db, deps.hub, {
      pluginId: payload.pluginId,
      threadId: payload.threadId,
      category: payload.category,
      title: payload.title,
      body: payload.body,
      payload: payload.payload,
      rendererId: payload.rendererId,
      dedupeKey: payload.dedupeKey,
      attention: payload.attention,
    });
    if (!result) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(
      toNotification(
        requireNotificationWithTarget(deps, result.notification.id),
      ),
      201,
    );
  });

  get(routes.list, (context, query) => {
    const filters = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.threadId ? { threadId: query.threadId } : {}),
    };
    return context.json({
      notifications: listNotifications(deps.db, {
        ...filters,
        state: query.state,
      }).map(toNotification),
      unreadCount: countUnreadNotifications(deps.db, filters),
    });
  });

  post(routes.read, (context) => {
    const id = context.req.param("id");
    if (!markNotificationRead(deps.db, deps.hub, id)) {
      throw new ApiError(
        404,
        "notification_not_found",
        "Notification not found",
      );
    }
    return context.json(
      toNotification(requireNotificationWithTarget(deps, id)),
    );
  });

  post(routes.dismiss, (context) => {
    const id = context.req.param("id");
    if (!dismissNotification(deps.db, deps.hub, id)) {
      throw new ApiError(
        404,
        "notification_not_found",
        "Notification not found",
      );
    }
    return context.json(
      toNotification(requireNotificationWithTarget(deps, id)),
    );
  });

  post(routes.open, (context) => {
    const notificationId = context.req.param("id");
    const notification = getNotification(deps.db, notificationId);
    if (!notification) {
      throw new ApiError(
        404,
        "notification_not_found",
        "Notification not found",
      );
    }

    const target = resolveNotificationTargetThread(
      deps.db,
      notification.threadId,
    );
    if (!target) {
      // Opening a durable row is an acknowledgement even when its target has
      // since been deleted or retired without a live lineage head.
      markNotificationRead(deps.db, deps.hub, notificationId);
      return context.json({
        outcome: "target-missing" as const,
        threadId: notification.threadId,
        redirectedFromThreadId: null,
        restored: { unhidden: false, unarchived: false },
      });
    }

    const revealed = revealThread(deps.db, deps.hub, {
      threadId: target.thread.id,
      // A user opening an inbox row explicitly restores their own thread.
      // Plugin-owned workers remain hidden sidebar implementation details.
      unhide: target.thread.originPluginId === null,
      unarchive: true,
    });
    if (!revealed) {
      markNotificationRead(deps.db, deps.hub, notificationId);
      return context.json({
        outcome: "target-missing" as const,
        threadId: target.thread.id,
        redirectedFromThreadId:
          target.thread.id === notification.threadId
            ? null
            : notification.threadId,
        restored: { unhidden: false, unarchived: false },
      });
    }

    const delivered = deps.hub.notifyThreadOpen(
      {
        projectId: revealed.thread.projectId,
        threadId: revealed.thread.id,
      },
      { split: "replace", file: null },
    );
    markNotificationRead(deps.db, deps.hub, notificationId);
    return context.json({
      outcome: delivered > 0 ? ("focused" as const) : ("no-client" as const),
      threadId: revealed.thread.id,
      redirectedFromThreadId:
        revealed.thread.id === notification.threadId
          ? null
          : notification.threadId,
      restored: revealed.restored,
    });
  });
}
