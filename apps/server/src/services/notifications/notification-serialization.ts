import type { NotificationListRow } from "@bb/db";
import { notificationSchema, type Notification } from "@bb/domain";
import { ApiError } from "../../errors.js";

export class NotificationSerializationError extends ApiError {
  readonly notificationId: string;

  constructor(notificationId: string) {
    super(500, "internal_error", "Stored notification payload is invalid");
    this.notificationId = notificationId;
  }
}

export function toNotification(row: NotificationListRow): Notification {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new NotificationSerializationError(row.id);
  }

  try {
    return notificationSchema.parse({
      id: row.id,
      threadId: row.threadId,
      projectId: row.projectId,
      sourceKind: row.sourceKind,
      pluginId: row.pluginId,
      category: row.category,
      title: row.title,
      body: row.body,
      payload,
      rendererId: row.rendererId,
      dedupeKey: row.dedupeKey,
      attention: row.attention,
      createdAt: row.createdAt,
      readAt: row.readAt,
      dismissedAt: row.dismissedAt,
      target:
        row.targetThreadId === null || row.targetDeletedAt !== null
          ? null
          : {
              threadId: row.targetThreadId,
              title: row.targetTitle,
              titleFallback: row.targetTitleFallback,
              visibility: row.targetVisibility,
              archivedAt: row.targetArchivedAt,
            },
    });
  } catch {
    throw new NotificationSerializationError(row.id);
  }
}
