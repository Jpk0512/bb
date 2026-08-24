// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "@bb/shared-ui/switch";

afterEach(() => {
  cleanup();
});

/**
 * M1.3: guards the control-size-scale rework — the checked track paints with
 * `--primary` (not `--foreground`, which read as "just dark ink" rather than
 * an accent), the track is sized 32x18 (36x20 on a coarse pointer), and the
 * outer button grows to a 44px hit area on that same coarse breakpoint.
 */
describe("Switch", () => {
  it("toggles via onCheckedChange on click", () => {
    const onCheckedChange = vi.fn();
    const { getByRole } = render(
      <Switch checked={false} onCheckedChange={onCheckedChange} />,
    );
    fireEvent.click(getByRole("switch"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("paints the checked track with --primary, not --foreground", () => {
    const { getByRole } = render(
      <Switch checked onCheckedChange={() => {}} />,
    );
    const track = getByRole("switch").querySelector("[data-state]");
    expect(track?.className).toContain("data-[state=checked]:bg-primary");
    expect(track?.className).not.toContain("bg-foreground");
  });

  it("sizes the track 32x18, growing to 36x20 on a coarse pointer", () => {
    const { getByRole } = render(
      <Switch checked={false} onCheckedChange={() => {}} />,
    );
    const track = getByRole("switch").querySelector("[data-state]");
    expect(track?.className).toContain("h-[18px]");
    expect(track?.className).toContain("w-8");
    expect(track?.className).toContain("max-md:pointer-coarse:h-5");
    expect(track?.className).toContain("max-md:pointer-coarse:w-9");
  });

  it("grows the button's own hit area to 44px on a coarse pointer", () => {
    const { getByRole } = render(
      <Switch checked={false} onCheckedChange={() => {}} />,
    );
    const button = getByRole("switch");
    expect(button.className).toContain("max-md:pointer-coarse:h-11");
    expect(button.className).toContain("max-md:pointer-coarse:w-11");
  });

  it("does not toggle when disabled", () => {
    const onCheckedChange = vi.fn();
    const { getByRole } = render(
      <Switch checked={false} disabled onCheckedChange={onCheckedChange} />,
    );
    fireEvent.click(getByRole("switch"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
