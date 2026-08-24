import { describe, expect, it } from "vitest";
import { CONTEXT_SELECTION_SURFACE_CLASS } from "@/components/ui/context-selection";
import {
  SIDEBAR_ROW_LEADING_SLOT_CLASS,
  SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
  SIDEBAR_ROW_SELECTED_STATE_CLASS,
} from "./sidebarRowClasses";

describe("sidebar thread state styling", () => {
  it("uses the shared active-context surface", () => {
    expect(SIDEBAR_ROW_SELECTED_STATE_CLASS).toContain(
      CONTEXT_SELECTION_SURFACE_CLASS,
    );
    expect(CONTEXT_SELECTION_SURFACE_CLASS).toBe("bg-state-active");
  });

  it("marks the row for an opaque backing surface when it becomes sticky", () => {
    expect(SIDEBAR_ROW_SELECTED_STATE_CLASS).toContain(
      "bb-sidebar-selected-row",
    );
  });

  it("marks open-in-split rows for an opaque sidebar-resolved tint", () => {
    expect(SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS).toBe(
      "bb-sidebar-open-in-split-row",
    );
  });
});

describe("sidebar row leading slot", () => {
  it("reserves a fixed-width box so titles align whether or not a glyph renders", () => {
    expect(SIDEBAR_ROW_LEADING_SLOT_CLASS).toContain("w-4");
    expect(SIDEBAR_ROW_LEADING_SLOT_CLASS).toContain("shrink-0");
  });
});
