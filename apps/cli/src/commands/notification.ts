import { Command } from "commander";
import type { Notification, NotificationListState } from "@bb/domain";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

interface NotificationListCommandOptions {
  json?: boolean;
  project?: string;
  state?: string;
  thread?: string;
}

interface NotificationActionCommandOptions {
  json?: boolean;
}

const NOTIFICATION_LIST_STATES = ["open", "unread", "all"] as const;

function parseNotificationListState(value: string | undefined): NotificationListState {
  if (value === undefined) return "open";
  if ((NOTIFICATION_LIST_STATES as readonly string[]).includes(value)) {
    return value as NotificationListState;
  }
  throw new Error(
    `--state must be one of ${NOTIFICATION_LIST_STATES.join(", ")}`,
  );
}

/**
 * Read-side access to the inbox for users and agents alike.
 *
 * Creating a notification stays plugin-only — the inbox is an announcement
 * channel, not a message bus — but an agent coordinating other threads needs
 * to see what has been announced to it, and previously had no way to.
 */
export function registerNotificationCommands(
  program: Command,
  getUrl: () => string,
): void {
  const notification = program
    .command("notification")
    .description("Inspect the notification inbox");

  notification
    .command("list")
    .description("List notifications")
    .option("--thread <id>", "Only notifications on this thread")
    .option("--project <id>", "Only notifications in this project")
    .option(
      "--state <state>",
      `Which notifications to include (${NOTIFICATION_LIST_STATES.join("|")})`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: NotificationListCommandOptions) => {
        const state = parseNotificationListState(opts.state);
        const result = await createCliBbSdk(getUrl()).notifications.list({
          state,
          ...(opts.thread ? { threadId: opts.thread } : {}),
          ...(opts.project ? { projectId: opts.project } : {}),
        });
        if (outputJson(opts, result)) return;
        if (result.notifications.length === 0) {
          console.log("No notifications");
          return;
        }
        printNotificationTable(result.notifications);
      }),
    );

  notification
    .command("read <notificationId>")
    .description("Mark a notification as seen")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (notificationId: string, opts: NotificationActionCommandOptions) => {
          const result = await createCliBbSdk(getUrl()).notifications.read({
            notificationId,
          });
          if (outputJson(opts, result)) return;
          console.log(`Marked ${notificationId} read`);
        },
      ),
    );

  notification
    .command("dismiss <notificationId>")
    .description("Remove a notification from the inbox")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (notificationId: string, opts: NotificationActionCommandOptions) => {
          const result = await createCliBbSdk(getUrl()).notifications.dismiss({
            notificationId,
          });
          if (outputJson(opts, result)) return;
          console.log(`Dismissed ${notificationId}`);
        },
      ),
    );
}

function printNotificationTable(notifications: Notification[]): void {
  const rows = notifications.map((entry) => [
    entry.id,
    entry.category,
    entry.readAt === null ? "unread" : "read",
    entry.title,
  ]);
  const idWidth = Math.max(2, ...rows.map((row) => row[0].length));
  const categoryWidth = Math.max(8, ...rows.map((row) => row[1].length));
  const stateWidth = Math.max(5, ...rows.map((row) => row[2].length));
  const titleWidth = Math.max(5, ...rows.map((row) => row[3].length));
  const table = renderBorderlessTable(
    {
      head: ["ID", "Category", "State", "Title"],
      colWidths: [idWidth, categoryWidth, stateWidth, titleWidth],
      trimTrailingWhitespace: true,
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}
