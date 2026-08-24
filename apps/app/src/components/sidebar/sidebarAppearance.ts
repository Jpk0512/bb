import { atomWithStorage } from "jotai/utils";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";

export const SIDEBAR_APPEARANCE_STORAGE_KEY = "bb.sidebar.appearance";

/** The desktop sidebar presentation selected in Settings → Appearance. */
export const SIDEBAR_APPEARANCE_OPTIONS = [
  "auto",
  "expanded",
  "compact",
] as const;

export type SidebarAppearance = (typeof SIDEBAR_APPEARANCE_OPTIONS)[number];

export function parseSidebarAppearance(
  value: string | null,
  fallback: SidebarAppearance = "auto",
): SidebarAppearance {
  if (
    value !== null &&
    (SIDEBAR_APPEARANCE_OPTIONS as readonly string[]).includes(value)
  ) {
    return value as SidebarAppearance;
  }
  return fallback;
}

export const sidebarAppearanceAtom = atomWithStorage<SidebarAppearance>(
  SIDEBAR_APPEARANCE_STORAGE_KEY,
  "auto",
  createLocalStorageSyncStorage<SidebarAppearance>({
    parse: (storedValue, initialValue) =>
      parseSidebarAppearance(storedValue, initialValue),
    serialize: (value) => value,
  }),
  { getOnInit: true },
);
