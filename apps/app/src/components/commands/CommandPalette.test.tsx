// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  openPalette: null as (() => boolean) | null,
}));

vi.mock("./AppCommandProvider", () => ({
  useAppCommandHandler: (_command: string, handler: () => boolean) => {
    fixture.openPalette = handler;
  },
  useAppCommandProvider: () => ({ dispatch: vi.fn() }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadSearch: ({ query }: { query: string }) => ({
    data: { active: { results: [] }, archived: { results: [] } },
    debouncedQuery: query.trim(),
    hasSearchableQuery: query.trim().length >= 2,
    isDebouncing: false,
    isLoading: false,
  }),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => fixture.navigate,
}));

import { CommandPalette, filterCommandPaletteCommands } from "./CommandPalette";

afterEach(() => {
  fixture.navigate.mockReset();
  fixture.openPalette = null;
});

describe("filterCommandPaletteCommands", () => {
  it("matches command labels fuzzily and prioritizes close matches", () => {
    const matches = filterCommandPaletteCommands("new th");

    expect(matches[0]).toMatchObject({
      command: "thread.new",
      label: "New thread",
    });
  });

  it("returns the full command catalog for an empty search", () => {
    expect(filterCommandPaletteCommands("")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "thread.new" }),
        expect.objectContaining({ command: "command.palette" }),
      ]),
    );
  });

  it("opens a prompt-seeded new thread when Enter has no matches", () => {
    render(<CommandPalette />);
    if (fixture.openPalette === null) {
      throw new Error("Expected the palette command handler to register");
    }
    act(() => fixture.openPalette?.());

    const input = screen.getByRole("textbox", {
      name: "Search commands and threads",
    });
    fireEvent.change(input, { target: { value: "zzzz no match" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(fixture.navigate).toHaveBeenCalledWith("/", {
      state: {
        focusPrompt: true,
        initialPrompt: "zzzz no match",
        replaceInitialPrompt: true,
      },
    });
  });
});
