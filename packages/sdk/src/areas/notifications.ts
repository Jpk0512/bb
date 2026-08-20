import type { Notification, NotificationListState } from "@bb/domain";
import type {
  CreateNotificationRequest,
  NotificationListResponse,
  NotificationOpenResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface NotificationCreateArgs extends Omit<
  CreateNotificationRequest,
  "pluginId"
> {
  /** Filled automatically for plugin-scoped SDK instances. */
  pluginId?: string;
  signal?: AbortSignal;
}

export interface NotificationListArgs {
  projectId?: string;
  signal?: AbortSignal;
  state?: NotificationListState;
  threadId?: string;
}

export interface NotificationActionArgs {
  notificationId: string;
  signal?: AbortSignal;
}

export type NotificationCreateResult = Notification;
export type NotificationListResult = NotificationListResponse;
export type NotificationReadResult = Notification;
export type NotificationDismissResult = Notification;
export type NotificationOpenResult = NotificationOpenResponse;

export interface NotificationsArea {
  create(args: NotificationCreateArgs): Promise<NotificationCreateResult>;
  dismiss(args: NotificationActionArgs): Promise<NotificationDismissResult>;
  list(args?: NotificationListArgs): Promise<NotificationListResult>;
  open(args: NotificationActionArgs): Promise<NotificationOpenResult>;
  read(args: NotificationActionArgs): Promise<NotificationReadResult>;
}

export function createNotificationsArea(
  args: CreateSdkAreaArgs,
): NotificationsArea {
  const { transport } = args;
  return {
    async create(input) {
      if (!input.pluginId) {
        throw new Error(
          "notifications.create requires pluginId outside a plugin-scoped SDK",
        );
      }
      const {
        signal,
        pluginId,
        threadId,
        category,
        title,
        body,
        payload,
        rendererId,
        dedupeKey,
        attention,
      } = input;
      return transport.readJson(
        transport.api.v1.notifications.$post(
          {
            json: {
              pluginId,
              threadId,
              category,
              title,
              ...(body === undefined ? {} : { body }),
              ...(payload === undefined ? {} : { payload }),
              ...(rendererId === undefined ? {} : { rendererId }),
              ...(dedupeKey === undefined ? {} : { dedupeKey }),
              ...(attention === undefined ? {} : { attention }),
            },
          },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async dismiss(input) {
      return transport.readJson(
        transport.api.v1.notifications[":id"].dismiss.$post(
          { param: { id: input.notificationId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async list(input = {}) {
      return transport.readJson(
        transport.api.v1.notifications.$get(
          {
            query: {
              ...(input.projectId === undefined
                ? {}
                : { projectId: input.projectId }),
              ...(input.threadId === undefined
                ? {}
                : { threadId: input.threadId }),
              state: input.state ?? "open",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async open(input) {
      return transport.readJson(
        transport.api.v1.notifications[":id"].open.$post(
          { param: { id: input.notificationId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async read(input) {
      return transport.readJson(
        transport.api.v1.notifications[":id"].read.$post(
          { param: { id: input.notificationId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
