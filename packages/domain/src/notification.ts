import { z } from "zod";
import { jsonValueSchema } from "./json-value.js";
import { threadVisibilitySchema } from "./thread-visibility.js";

export const notificationSourceKindSchema = z.enum(["plugin", "system"]);
export type NotificationSourceKind = z.infer<
  typeof notificationSourceKindSchema
>;

export const notificationCategorySchema = z.enum([
  "review-ready",
  "worker-finished",
  "approval-needed",
  "info",
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export const notificationTargetSchema = z
  .object({
    threadId: z.string().min(1),
    title: z.string().nullable(),
    titleFallback: z.string().nullable(),
    visibility: threadVisibilitySchema,
    archivedAt: z.number().nullable(),
  })
  .strict();
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;

/**
 * A durable, non-blocking notification. Read and dismissed are deliberately
 * independent: reading acknowledges the row, while dismissal removes it from
 * the open inbox.
 */
export const notificationSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    projectId: z.string().min(1),
    sourceKind: notificationSourceKindSchema,
    pluginId: z.string().min(1).nullable(),
    category: notificationCategorySchema,
    title: z.string().min(1),
    body: z.string().nullable(),
    payload: jsonValueSchema,
    rendererId: z.string().min(1).nullable(),
    dedupeKey: z.string().min(1).nullable(),
    attention: z.boolean(),
    createdAt: z.number(),
    readAt: z.number().nullable(),
    dismissedAt: z.number().nullable(),
    /** Null when the target thread has been soft-deleted. */
    target: notificationTargetSchema.nullable(),
  })
  .strict();
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListStateSchema = z.enum(["open", "all"]);
export type NotificationListState = z.infer<typeof notificationListStateSchema>;
