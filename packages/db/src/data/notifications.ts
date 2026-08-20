import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  isNull,
} from "drizzle-orm";
import type {
  JsonValue,
  NotificationCategory,
  NotificationListState,
} from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { createNotificationId } from "../ids.js";
import type { DbNotifier } from "../notifier.js";
import { noopNotifier } from "../notifier.js";
import { notifications, threads } from "../schema.js";
import { markThreadAttentionRequested } from "./threads.js";

export type NotificationRow = typeof notifications.$inferSelect;

interface CreateNotificationInputBase {
  attention?: boolean;
  body?: string | null;
  category: NotificationCategory;
  dedupeKey?: string | null;
  payload?: JsonValue;
  rendererId?: string | null;
  threadId: string;
  title: string;
}

export type CreateNotificationInput =
  | (CreateNotificationInputBase & {
      pluginId: string;
      sourceKind?: "plugin";
    })
  | (CreateNotificationInputBase & {
      pluginId?: null;
      sourceKind: "system";
    });

export interface CreateNotificationResult {
  created: boolean;
  notification: NotificationRow;
}

export interface ListNotificationsArgs {
  projectId?: string;
  state?: NotificationListState;
  threadId?: string;
}

export interface NotificationListRow extends NotificationRow {
  targetArchivedAt: number | null;
  targetDeletedAt: number | null;
  targetThreadId: string | null;
  targetTitle: string | null;
  targetTitleFallback: string | null;
  targetVisibility: "hidden" | "visible" | null;
}

function notifyNotificationChanged(
  notifier: DbNotifier,
  notification: Pick<NotificationRow, "projectId" | "threadId">,
): void {
  notifier.notifyThread(notification.threadId, ["notifications-changed"], {
    projectId: notification.projectId,
  });
  notifier.notifySystem(["notifications-changed"]);
}

export function createNotification(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateNotificationInput,
): CreateNotificationResult | null {
  let attentionChanged = false;
  const result = db.transaction((tx): CreateNotificationResult | null => {
    if (
      input.sourceKind !== "system" &&
      input.dedupeKey !== undefined &&
      input.dedupeKey !== null
    ) {
      const existing = tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.pluginId, input.pluginId),
            eq(notifications.dedupeKey, input.dedupeKey),
          ),
        )
        .get();
      if (existing) {
        return { created: false, notification: existing };
      }
    }

    const thread = tx
      .select()
      .from(threads)
      .where(and(eq(threads.id, input.threadId), isNull(threads.deletedAt)))
      .get();
    if (!thread) {
      return null;
    }

    const now = Date.now();
    const notification = tx
      .insert(notifications)
      .values({
        id: createNotificationId(),
        threadId: thread.id,
        projectId: thread.projectId,
        sourceKind: input.sourceKind ?? "plugin",
        pluginId: input.sourceKind === "system" ? null : input.pluginId,
        category: input.category,
        title: input.title,
        body: input.body ?? null,
        payload: JSON.stringify(input.payload ?? {}),
        rendererId: input.rendererId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        attention: input.attention ?? true,
        createdAt: now,
        readAt: null,
        dismissedAt: null,
      })
      .returning()
      .get();

    if (notification.attention) {
      const attentionThread = markThreadAttentionRequested(tx, noopNotifier, {
        threadId: thread.id,
      });
      attentionChanged =
        attentionThread !== null &&
        attentionThread.latestAttentionAt > thread.latestAttentionAt;
    }
    return { created: true, notification };
  });

  if (result?.created) {
    if (attentionChanged) {
      notifier.notifyThread(result.notification.threadId, [
        "read-state-changed",
      ], {
        projectId: result.notification.projectId,
      });
    }
    notifyNotificationChanged(notifier, result.notification);
  }
  return result;
}

export function getNotification(
  db: DbQueryConnection,
  id: string,
): NotificationRow | null {
  return (
    db.select().from(notifications).where(eq(notifications.id, id)).get() ??
    null
  );
}

export function listNotifications(
  db: DbQueryConnection,
  args: ListNotificationsArgs = {},
): NotificationListRow[] {
  return db
    .select({
      ...getTableColumns(notifications),
      targetThreadId: threads.id,
      targetTitle: threads.title,
      targetTitleFallback: threads.titleFallback,
      targetVisibility: threads.visibility,
      targetArchivedAt: threads.archivedAt,
      targetDeletedAt: threads.deletedAt,
    })
    .from(notifications)
    .leftJoin(threads, eq(notifications.threadId, threads.id))
    .where(
      and(
        args.projectId
          ? eq(notifications.projectId, args.projectId)
          : undefined,
        args.threadId ? eq(notifications.threadId, args.threadId) : undefined,
        (args.state ?? "open") === "open"
          ? isNull(notifications.dismissedAt)
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .all();
}

export function countUnreadNotifications(
  db: DbQueryConnection,
  args: Pick<ListNotificationsArgs, "projectId" | "threadId"> = {},
): number {
  return (
    db
      .select({ count: count() })
      .from(notifications)
      .where(
        and(
          args.projectId
            ? eq(notifications.projectId, args.projectId)
            : undefined,
          args.threadId
            ? eq(notifications.threadId, args.threadId)
            : undefined,
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
        ),
      )
      .get()?.count ?? 0
  );
}

export function countUnreadNotificationsByThread(
  db: DbQueryConnection,
  threadId: string,
): number {
  return countUnreadNotifications(db, { threadId });
}

export function markNotificationRead(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
): NotificationRow | null {
  const existing = getNotification(db, id);
  if (!existing || existing.readAt !== null) {
    return existing;
  }
  const updated = db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
    .returning()
    .get();
  if (updated) {
    notifyNotificationChanged(notifier, updated);
  }
  return updated ?? getNotification(db, id);
}

export function dismissNotification(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
): NotificationRow | null {
  const existing = getNotification(db, id);
  if (!existing || existing.dismissedAt !== null) {
    return existing;
  }
  const updated = db
    .update(notifications)
    .set({ dismissedAt: Date.now() })
    .where(and(eq(notifications.id, id), isNull(notifications.dismissedAt)))
    .returning()
    .get();
  if (updated) {
    notifyNotificationChanged(notifier, updated);
  }
  return updated ?? getNotification(db, id);
}
