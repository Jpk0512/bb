import { z } from "zod";
import {
  jsonValueSchema,
  notificationCategorySchema,
  notificationListStateSchema,
  notificationSchema,
} from "@bb/domain";

/**
 * `pluginId` is filled by the plugin-scoped SDK wrapper. Raw SDK callers must
 * provide it explicitly; the server rejects an omitted value.
 */
export const createNotificationRequestSchema = z
  .object({
    threadId: z.string().min(1),
    pluginId: z.string().min(1),
    category: notificationCategorySchema,
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    payload: jsonValueSchema.optional(),
    rendererId: z.string().min(1).nullable().optional(),
    dedupeKey: z.string().min(1).nullable().optional(),
    attention: z.boolean().optional(),
  })
  .strict();
export type CreateNotificationRequest = z.infer<
  typeof createNotificationRequestSchema
>;

export const notificationListQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    state: notificationListStateSchema.default("open"),
  })
  .strict();
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = z
  .object({
    notifications: z.array(notificationSchema),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationListResponse = z.infer<
  typeof notificationListResponseSchema
>;

export const notificationOpenOutcomeSchema = z.enum([
  "focused",
  "no-client",
  "target-missing",
]);
export type NotificationOpenOutcome = z.infer<
  typeof notificationOpenOutcomeSchema
>;

export const notificationOpenResponseSchema = z
  .object({
    outcome: notificationOpenOutcomeSchema,
    threadId: z.string().min(1),
    redirectedFromThreadId: z.string().min(1).nullable(),
    restored: z
      .object({
        unhidden: z.boolean(),
        unarchived: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type NotificationOpenResponse = z.infer<
  typeof notificationOpenResponseSchema
>;
