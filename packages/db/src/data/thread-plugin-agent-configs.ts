import { eq } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import { threadPluginAgentConfigs } from "../schema.js";

export type ThreadPluginAgentConfigRow =
  typeof threadPluginAgentConfigs.$inferSelect;

/**
 * Read the raw persisted pin rows for one thread. JSON is intentionally kept
 * raw at the data boundary; the plugin service applies its normal selection
 * validation with the currently registered tool and skill ids.
 */
export function listThreadPluginAgentConfigRows(
  db: DbQueryConnection,
  threadId: string,
): ThreadPluginAgentConfigRow[] {
  return db
    .select()
    .from(threadPluginAgentConfigs)
    .where(eq(threadPluginAgentConfigs.threadId, threadId))
    .all();
}
