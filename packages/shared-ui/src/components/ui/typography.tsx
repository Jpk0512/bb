import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * v2 typography ramp (M1.1): semantic text primitives so call sites reach for
 * a named tier instead of hand-rolling a size/weight/tracking/color
 * combination inline. Each component owns exactly one tier's rules; do not
 * add a `variant` prop that blends tiers — add a new component instead.
 *
 * This lands the tokens/components only. Restyling the sidebar to actually
 * use these throughout is Phase 2 — out of scope here.
 */

type TextSpanProps = React.HTMLAttributes<HTMLSpanElement>;

/** A sidebar navigation row's label (Threads, Extensions, Settings, ...). */
const SidebarNavText = React.forwardRef<HTMLSpanElement, TextSpanProps>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn("text-sm font-medium text-foreground", className)}
      {...props}
    />
  ),
);
SidebarNavText.displayName = "SidebarNavText";

/** A sidebar thread row's title — one step lighter than a nav row. */
const SidebarThreadText = React.forwardRef<HTMLSpanElement, TextSpanProps>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn("text-sm font-normal text-muted-foreground", className)}
      {...props}
    />
  ),
);
SidebarThreadText.displayName = "SidebarThreadText";

/** A group/section header (Pinned, Projects, Threads, ...): small, uppercase,
 * tracked-out caps read as chrome rather than content. */
const SectionLabel = React.forwardRef<HTMLSpanElement, TextSpanProps>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
);
SectionLabel.displayName = "SectionLabel";

/** Secondary/meta copy (timestamps, counts, byline-style detail) that should
 * never compete with the primary label it sits beside. */
const MetaText = React.forwardRef<HTMLSpanElement, TextSpanProps>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  ),
);
MetaText.displayName = "MetaText";

/** An inline shell command, file path, or other monospace token. Numbers in
 * mono commands are almost always counts/offsets, so default to tabular-nums
 * so digit columns don't jitter as they change. */
const MonoCommand = React.forwardRef<HTMLSpanElement, TextSpanProps>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "font-mono text-[12px] tabular-nums text-foreground",
        className,
      )}
      {...props}
    />
  ),
);
MonoCommand.displayName = "MonoCommand";

export { SidebarNavText, SidebarThreadText, SectionLabel, MetaText, MonoCommand };
