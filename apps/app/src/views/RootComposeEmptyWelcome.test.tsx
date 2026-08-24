// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { makeThreadListEntry } from "@/test/fixtures/thread-list-entries";
import { RootComposeEmptyWelcome } from "./RootComposeEmptyWelcome";

afterEach(cleanup);

describe("RootComposeEmptyWelcome", () => {
  it("shows the three most recent active threads before the welcome actions", () => {
    render(
      <MemoryRouter>
        <RootComposeEmptyWelcome
          onCompose={() => undefined}
          onAddProject={() => undefined}
          threads={[
            makeThreadListEntry({
              id: "older",
              title: "Older thread",
              latestAttentionAt: 10,
              status: "active",
            }),
            makeThreadListEntry({
              id: "newest",
              title: "Newest thread",
              latestAttentionAt: 30,
              status: "active",
            }),
            makeThreadListEntry({
              id: "middle",
              title: "Middle thread",
              latestAttentionAt: 20,
              status: "active",
            }),
            makeThreadListEntry({
              id: "archived",
              title: "Archived thread",
              latestAttentionAt: 40,
              status: "active",
              archivedAt: 50,
            }),
            makeThreadListEntry({
              id: "fourth",
              title: "Fourth thread",
              latestAttentionAt: 1,
              status: "active",
            }),
            makeThreadListEntry({
              id: "historical",
              title: "Historical thread",
              latestAttentionAt: 50,
              updatedAt: 1,
              status: "idle",
            }),
          ]}
        />
      </MemoryRouter>,
    );

    const continueHeading = screen.getByRole("heading", { name: "Continue" });
    const links = screen.getAllByRole("link");
    expect(continueHeading.compareDocumentPosition(links[0]!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(links.map((link) => link.textContent)).toEqual([
      "Newest thread",
      "Middle thread",
      "Older thread",
    ]);
    expect(screen.queryByText("Archived thread")).toBeNull();
    expect(screen.queryByText("Fourth thread")).toBeNull();
    expect(screen.queryByText("Historical thread")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "New threadStart a new conversation",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Learn what bb can doGet a tour of its capabilities",
      }),
    ).not.toBeNull();
    expect(links[0]?.getAttribute("href")).toBe(
      "/projects/proj_test/threads/newest",
    );
  });

  it("prefers live work over newer idle recents", () => {
    render(
      <MemoryRouter>
        <RootComposeEmptyWelcome
          onCompose={() => undefined}
          onAddProject={() => undefined}
          threads={[
            makeThreadListEntry({
              id: "running",
              title: "Running thread",
              latestAttentionAt: 1,
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
            }),
            makeThreadListEntry({
              id: "needs-input",
              title: "Needs input",
              latestAttentionAt: 2,
              hasPendingInteraction: true,
            }),
            makeThreadListEntry({
              id: "idle-recent",
              title: "Idle recent",
              latestAttentionAt: 100,
              updatedAt: Date.now(),
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      ["Needs input", "Running thread"],
    );
  });
});
