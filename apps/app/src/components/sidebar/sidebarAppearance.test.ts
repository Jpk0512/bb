// @vitest-environment jsdom

import { createStore } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_APPEARANCE_STORAGE_KEY,
  parseSidebarAppearance,
  sidebarAppearanceAtom,
} from "./sidebarAppearance";

afterEach(() => window.localStorage.clear());

describe("sidebarAppearanceAtom", () => {
  it("defaults to Auto and persists an explicit compact rail preference", () => {
    const store = createStore();

    expect(store.get(sidebarAppearanceAtom)).toBe("auto");
    store.set(sidebarAppearanceAtom, "compact");

    expect(window.localStorage.getItem(SIDEBAR_APPEARANCE_STORAGE_KEY)).toBe(
      "compact",
    );
  });

  it("rejects stale stored appearance values", () => {
    expect(parseSidebarAppearance("wide")).toBe("auto");
    expect(parseSidebarAppearance(null, "expanded")).toBe("expanded");
  });
});
