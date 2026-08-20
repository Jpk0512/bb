import { useMemo, useState } from "react";
import type { Notification } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Pill } from "@bb/shared-ui/pill";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  useDismissNotification,
  useNotificationList,
  useOpenNotification,
} from "@/hooks/queries/notification-queries";
import { formatRelativeTime } from "@/lib/relative-time";
import { resolveNotificationBody } from "@/lib/plugin-slot-resolvers";
import { usePluginSlots } from "@/lib/plugin-slots";

type TargetState = "visible" | "hidden" | "archived" | "missing";

function targetState(notification: Notification): TargetState {
  if (notification.target === null) return "missing";
  if (notification.target.archivedAt !== null) return "archived";
  return notification.target.visibility;
}

function targetLabel(state: TargetState): string {
  switch (state) {
    case "visible":
      return "Visible thread";
    case "hidden":
      return "Hidden thread";
    case "archived":
      return "Archived thread";
    case "missing":
      return "Thread unavailable";
  }
}

function notificationThreadTitle(notification: Notification): string {
  return (
    notification.target?.title ??
    notification.target?.titleFallback ??
    "Deleted thread"
  );
}

interface InboxNotificationRowProps {
  notification: Notification;
}

function InboxNotificationRow({ notification }: InboxNotificationRowProps) {
  const { notificationBodies } = usePluginSlots();
  const dismiss = useDismissNotification();
  const open = useOpenNotification();
  const [targetMissing, setTargetMissing] = useState(false);
  const slot = useMemo(
    () =>
      notification.pluginId !== null && notification.rendererId !== null
        ? resolveNotificationBody(
            notificationBodies,
            notification.pluginId,
            notification.rendererId,
          )
        : null,
    [notification.pluginId, notification.rendererId, notificationBodies],
  );
  const state = targetState(notification);
  const unavailable = state === "missing" || targetMissing;

  return (
    <article
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
      data-testid={`inbox-notification-${notification.id}`}
      data-read={notification.readAt !== null || undefined}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={
            notification.readAt === null
              ? "mt-1.5 size-2 shrink-0 rounded-full bg-foreground"
              : "mt-1.5 size-2 shrink-0"
          }
          aria-label={notification.readAt === null ? "Unread" : "Read"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 text-sm font-semibold text-foreground">
              {notification.title}
            </h2>
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime({
                timestamp: notification.createdAt,
                now: Date.now(),
              })}
            </span>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {notificationThreadTitle(notification)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Pill variant={unavailable ? "outline" : "secondary"} size="sm">
              {unavailable ? "Thread unavailable" : targetLabel(state)}
            </Pill>
            {notification.body ? (
              <span className="text-sm text-muted-foreground">
                {notification.body}
              </span>
            ) : null}
          </div>
          {slot ? (
            <div className="mt-3">
              <PluginSlotMount
                pluginId={slot.pluginId}
                slotKind="notificationBody"
                slotId={slot.id}
                instanceId={notification.id}
                crashFallback={
                  <p className="text-sm text-muted-foreground">
                    This notification's plugin content is unavailable.
                  </p>
                }
              >
                <slot.component
                  notification={{
                    id: notification.id,
                    threadId: notification.threadId,
                    projectId: notification.projectId,
                    category: notification.category,
                    title: notification.title,
                    body: notification.body,
                    payload: notification.payload,
                    createdAt: notification.createdAt,
                    readAt: notification.readAt,
                  }}
                />
              </PluginSlotMount>
            </div>
          ) : null}
          {targetMissing ? (
            <p className="mt-3 text-sm text-muted-foreground" role="status">
              The target thread was deleted before this notification could open.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={unavailable || open.isPending}
            onClick={() => {
              void open
                .mutateAsync(notification.id)
                .then((result) => {
                  if (result.outcome === "target-missing") {
                    setTargetMissing(true);
                  }
                })
                .catch(() => {});
            }}
          >
            <Icon name="ExternalLink" aria-hidden="true" />
            Open
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={dismiss.isPending}
            onClick={() =>
              void dismiss.mutateAsync(notification.id).catch(() => {})
            }
          >
            Dismiss
          </Button>
        </div>
      </div>
    </article>
  );
}

export function InboxView() {
  const notifications = useNotificationList();
  const grouped = useMemo(() => {
    const byThread = new Map<string, Notification[]>();
    for (const notification of notifications.data?.notifications ?? []) {
      const group = byThread.get(notification.threadId) ?? [];
      group.push(notification);
      byThread.set(notification.threadId, group);
    }
    return [...byThread.values()];
  }, [notifications.data?.notifications]);

  if (notifications.isLoading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Loading inbox…</div>
    );
  }
  if (notifications.isError) {
    return (
      <div className="p-4 text-sm text-destructive">Unable to load inbox.</div>
    );
  }
  if (grouped.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Icon
          name="Mail"
          className="size-8 text-muted-foreground"
          aria-hidden="true"
        />
        <h1 className="text-base font-semibold text-foreground">
          Your inbox is clear
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Notifications from threads and plugins will appear here.
        </p>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {notifications.data?.unreadCount ?? 0} unread notification
            {(notifications.data?.unreadCount ?? 0) === 1 ? "" : "s"}
          </p>
        </div>
        {grouped.map((group) => (
          <section key={group[0]?.threadId} className="space-y-2">
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {group[0] ? notificationThreadTitle(group[0]) : "Thread"}
            </h2>
            <div className="space-y-2">
              {group.map((notification) => (
                <InboxNotificationRow
                  key={notification.id}
                  notification={notification}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
