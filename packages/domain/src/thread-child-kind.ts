import { z } from "zod";

/**
 * A plugin-owned role for a hierarchy child thread, for example
 * `dispatch:worker` or `board:reviewer`.
 *
 * This is deliberately a namespaced slug rather than an enum: plugins may
 * define multiple child roles without adding their product vocabulary to the
 * core domain package.
 */
export const threadChildKindSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9-]{0,31})?$/,
    "childKind must be a namespaced lowercase slug",
  );
export type ThreadChildKind = z.infer<typeof threadChildKindSchema>;
