import { useAtom } from "jotai";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { SettingsWithControl } from "@/components/ui/settings-section";
import {
  sidebarAppearanceAtom,
  SIDEBAR_APPEARANCE_OPTIONS,
  type SidebarAppearance,
} from "@/components/sidebar/sidebarAppearance";

const SIDEBAR_APPEARANCE_LABELS: Record<SidebarAppearance, string> = {
  auto: "Auto",
  expanded: "Expanded",
  compact: "Compact",
};

const SIDEBAR_APPEARANCE_DESCRIPTIONS: Record<SidebarAppearance, string> = {
  auto: "Follow the sidebar toggle.",
  expanded: "Keep the full sidebar visible.",
  compact: "Use a 56px icon rail for navigation and projects.",
};

export function SidebarAppearanceSetting() {
  const [appearance, setAppearance] = useAtom(sidebarAppearanceAtom);

  return (
    <SettingsWithControl
      label="Sidebar appearance"
      description="Choose how the desktop sidebar is shown on this device."
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="min-w-40 justify-between"
            aria-label="Sidebar appearance"
          >
            {SIDEBAR_APPEARANCE_LABELS[appearance]}
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {SIDEBAR_APPEARANCE_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option}
              onSelect={() => setAppearance(option)}
              className="flex items-start gap-2"
            >
              <span className="flex min-w-0 flex-col">
                <span>{SIDEBAR_APPEARANCE_LABELS[option]}</span>
                <span className="text-xs text-muted-foreground">
                  {SIDEBAR_APPEARANCE_DESCRIPTIONS[option]}
                </span>
              </span>
              <Icon
                name="Check"
                className={cn(
                  "ml-auto mt-0.5",
                  appearance !== option && "opacity-0",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}
