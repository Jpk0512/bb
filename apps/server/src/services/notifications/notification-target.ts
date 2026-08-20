import { resolveLineageHead } from "../threads/thread-lineage.js";

/** BBF-7's notification seam is BBF-3's lineage resolver by contract. */
export const resolveNotificationTargetThread = resolveLineageHead;
