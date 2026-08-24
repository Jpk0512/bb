// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MetaText,
  MonoCommand,
  SectionLabel,
  SidebarNavText,
  SidebarThreadText,
} from "@bb/shared-ui/typography";

afterEach(() => {
  cleanup();
});

/**
 * M1.1: guards that the v2 typography ramp's semantic components render with
 * the tier's size/weight/tracking/color classes, so a future edit to one
 * tier can't silently drift onto another's rules.
 */
describe("typography ramp", () => {
  it("renders SidebarNavText at 13px/500 in the foreground tier", () => {
    const { getByText } = render(<SidebarNavText>Threads</SidebarNavText>);
    const el = getByText("Threads");
    expect(el.className).toContain("text-sm");
    expect(el.className).toContain("font-medium");
    expect(el.className).toContain("text-foreground");
  });

  it("renders SidebarThreadText at 13px/400 in the muted tier", () => {
    const { getByText } = render(
      <SidebarThreadText>Fix the sidebar</SidebarThreadText>,
    );
    const el = getByText("Fix the sidebar");
    expect(el.className).toContain("text-sm");
    expect(el.className).toContain("font-normal");
    expect(el.className).toContain("text-muted-foreground");
  });

  it("renders SectionLabel uppercase with tracked-out caps", () => {
    const { getByText } = render(<SectionLabel>Pinned</SectionLabel>);
    const el = getByText("Pinned");
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("tracking-[0.06em]");
    expect(el.className).toContain("text-muted-foreground");
  });

  it("renders MetaText small and muted", () => {
    const { getByText } = render(<MetaText>2 minutes ago</MetaText>);
    const el = getByText("2 minutes ago");
    expect(el.className).toContain("text-xs");
    expect(el.className).toContain("text-muted-foreground");
  });

  it("renders MonoCommand in the mono font with tabular numerals", () => {
    const { getByText } = render(<MonoCommand>pnpm test 42</MonoCommand>);
    const el = getByText("pnpm test 42");
    expect(el.className).toContain("font-mono");
    expect(el.className).toContain("tabular-nums");
  });

  it("forwards a custom className without dropping the tier's own classes", () => {
    const { getByText } = render(
      <SidebarNavText className="truncate">Extensions</SidebarNavText>,
    );
    const el = getByText("Extensions");
    expect(el.className).toContain("truncate");
    expect(el.className).toContain("text-sm");
  });
});
