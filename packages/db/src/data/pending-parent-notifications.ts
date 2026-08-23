import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import type { ThreadEventTurnStatus } from "@bb/domain";
import { pendingParentNotifications } from "../schema.js";
import { createPendingParentNotificationClaimToken } from "../ids.js";

export type PendingParentNotificationRow =
  typeof pendingParentNotifications.$inferSelect;

export interface InsertPendingParentNotificationArgs {
  id: string;
  parentThreadId: string;
  childThreadId: string;
  childProjectId: string;
  childTitle: string | null;
  turnStatus: ThreadEventTurnStatus;
  activeWorkflowCount: number;
  terminalOutput: string | null;
  /** Coalescing window end: the batch is not delivered before this. */
  deliverAfter: number;
  now: number;
}

/**
 * Persist the intent to announce one child outcome to its parent. Written on
 * the settle path before any delivery attempt, so a crash, a restart, or a
 * parent that cannot accept the turn yet all leave a row the delivery sweep
 * can still act on.
 */
export function insertPendingParentNotification(
  db: DbConnection,
  args: InsertPendingParentNotificationArgs,
): void {
  db.insert(pendingParentNotifications)
    .values({
      id: args.id,
      parentThreadId: args.parentThreadId,
      childThreadId: args.childThreadId,
      childProjectId: args.childProjectId,
      childTitle: args.childTitle,
      turnStatus: args.turnStatus,
      activeWorkflowCount: args.activeWorkflowCount,
      terminalOutput: args.terminalOutput,
      deliverAfter: args.deliverAfter,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .run();
}

/**
 * Parents that have at least one row due for delivery. Delivery is per parent
 * rather than per row because several children settling close together are
 * announced as one batched system message.
 */
export function listParentThreadIdsWithDueNotifications(
  db: DbConnection,
  args: { now: number; limit: number; staleClaimBefore: number },
): string[] {
  const rows = db
    .selectDistinct({ parentThreadId: pendingParentNotifications.parentThreadId })
    .from(pendingParentNotifications)
    .where(
      and(
        lte(pendingParentNotifications.deliverAfter, args.now),
        or(
          isNull(pendingParentNotifications.claimedAt),
          lte(pendingParentNotifications.claimedAt, args.staleClaimBefore),
        ),
      ),
    )
    .orderBy(asc(pendingParentNotifications.parentThreadId))
    .limit(args.limit)
    .all();
  return rows.map((row) => row.parentThreadId);
}

/**
 * Take every deliverable row for one parent. Claiming is a single UPDATE
 * guarded on the same predicate used to find the work, so two concurrent
 * sweeps (or a sweep racing the in-process fast path) cannot both deliver.
 * A claim older than `staleClaimBefore` is reclaimable: the claimer may have
 * died mid-delivery.
 */
export function claimDueParentNotifications(
  db: DbConnection,
  args: { parentThreadId: string; now: number; staleClaimBefore: number },
): PendingParentNotificationRow[] {
  const claimToken = createPendingParentNotificationClaimToken();
  const claimed = db
    .update(pendingParentNotifications)
    .set({ claimedAt: args.now, claimToken, updatedAt: args.now })
    .where(
      and(
        eq(pendingParentNotifications.parentThreadId, args.parentThreadId),
        lte(pendingParentNotifications.deliverAfter, args.now),
        or(
          isNull(pendingParentNotifications.claimedAt),
          lte(pendingParentNotifications.claimedAt, args.staleClaimBefore),
        ),
      ),
    )
    .run();
  if (claimed.changes === 0) {
    return [];
  }

  return db
    .select()
    .from(pendingParentNotifications)
    .where(eq(pendingParentNotifications.claimToken, claimToken))
    .orderBy(
      asc(pendingParentNotifications.createdAt),
      asc(pendingParentNotifications.id),
    )
    .all();
}

/** Rows still owed to a parent, whether or not they are due yet. */
export function countPendingParentNotifications(
  db: DbConnection,
  parentThreadId: string,
): number {
  const [row] = db
    .select({ count: sql<number>`count(*)` })
    .from(pendingParentNotifications)
    .where(eq(pendingParentNotifications.parentThreadId, parentThreadId))
    .all();
  return row?.count ?? 0;
}

export function markParentNotificationsInboxEmitted(
  db: DbConnection,
  args: { ids: string[]; now: number },
): void {
  if (args.ids.length === 0) {
    return;
  }
  db.update(pendingParentNotifications)
    .set({ inboxEmittedAt: args.now, updatedAt: args.now })
    .where(inArray(pendingParentNotifications.id, args.ids))
    .run();
}

/** Delivery landed (or the parent is gone): the intent is discharged. */
export function deletePendingParentNotifications(
  db: DbConnection,
  ids: string[],
): void {
  if (ids.length === 0) {
    return;
  }
  db.delete(pendingParentNotifications)
    .where(inArray(pendingParentNotifications.id, ids))
    .run();
}

/**
 * Delivery could not happen yet. Release the claim and push `deliverAfter`
 * out so the next attempt does not hot-loop against a parent that is still
 * busy or still blocked on an interaction.
 *
 * `countsAsAttempt` separates the two reasons delivery gets postponed. A
 * parent blocked on an unanswered prompt is *waiting*, not failing: counting
 * that as an attempt would inflate the retry backoff for something that
 * resolves the moment the user answers, so those rows keep a short fixed
 * retry. Errors and status races do count, and back off exponentially.
 */
export function deferPendingParentNotifications(
  db: DbConnection,
  args: {
    ids: string[];
    deliverAfter: number;
    lastError: string | null;
    countsAsAttempt: boolean;
    now: number;
  },
): void {
  if (args.ids.length === 0) {
    return;
  }
  db.update(pendingParentNotifications)
    .set({
      ...(args.countsAsAttempt
        ? { attempts: sql`${pendingParentNotifications.attempts} + 1` }
        : {}),
      lastAttemptAt: args.now,
      lastError: args.lastError,
      deliverAfter: args.deliverAfter,
      claimedAt: null,
      claimToken: null,
      updatedAt: args.now,
    })
    .where(inArray(pendingParentNotifications.id, args.ids))
    .run();
}
