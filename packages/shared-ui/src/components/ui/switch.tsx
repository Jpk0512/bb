/* shadcn/ui-derived */
import * as React from "react";
import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

type SwitchProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "onChange" | "role"
> & {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/*
 * Control-size scale (M1.3): a 32x18 track (36x20 on a coarse/touch pointer,
 * matching the `max-md:pointer-coarse:` breakpoint used by every other
 * coarse-pointer control in this package, see coarse-pointer-sizing.ts). The
 * button itself grows to a 44px minimum hit area on that same breakpoint so a
 * touch target never falls below the accessible minimum, while the track
 * stays visually track-sized and centered inside it.
 */
const SWITCH_HIT_AREA_CLASS =
  "h-[18px] w-8 max-md:pointer-coarse:h-11 max-md:pointer-coarse:w-11";
const SWITCH_TRACK_CLASS =
  "h-[18px] w-8 max-md:pointer-coarse:h-5 max-md:pointer-coarse:w-9";
const SWITCH_THUMB_CLASS =
  "size-3.5 max-md:pointer-coarse:size-4 data-[state=checked]:translate-x-4 max-md:pointer-coarse:data-[state=checked]:translate-x-[18px]";

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, className, disabled, onCheckedChange, onClick, ...props }, ref) => (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        "peer inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        SWITCH_HIT_AREA_CLASS,
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
    >
      <span
        aria-hidden
        data-state={checked ? "checked" : "unchecked"}
        className={cn(
          `flex items-center rounded-full border border-transparent bg-input shadow-xs ${CONTROL_HOVER_TRANSITION} data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted`,
          SWITCH_TRACK_CLASS,
        )}
      >
        <span
          aria-hidden
          data-state={checked ? "checked" : "unchecked"}
          className={cn(
            "pointer-events-none block rounded-full bg-background ring-0 transition-transform data-[state=unchecked]:translate-x-0",
            SWITCH_THUMB_CLASS,
          )}
        />
      </span>
    </button>
  ),
);
Switch.displayName = "Switch";

export { Switch };
