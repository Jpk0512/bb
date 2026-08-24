export const meta = {
  name: "ui-master-phase-0",
  description:
    "Implement UI master-plan Phase 0 (BBF-31) in a dedicated worktree, board clip in the board plugin, then independently review.",
  phases: [
    { title: "Implement", detail: "Core Phase 0 in the ui-phase0 worktree plus board clip" },
    { title: "Review", detail: "Independent review of the Phase 0 diff" },
  ],
};

phase("Implement");
const implemented = await parallel([
  () =>
    agent(
      [
        "You are the Phase 0 implementer for bb core. Read /tmp/bb-ui-review/PHASE-0-BRIEF.md and /tmp/bb-ui-review/MASTER-IMPLEMENTATION.md Phase 0 only.",
        "Work ONLY in /Users/john.keeney/bb-wt/ui-phase0 on branch nsai/ui-phase-0.",
        "Do not edit /Users/john.keeney/bb. Do not run pnpm reset or pnpm dev. Do not restart the LaunchAgent.",
        "Implement M0.1, M0.2, M0.3, M0.4 (contrast + border only, no repo-wide hex ban), and M0.6.",
        "Use pnpm exec turbo run test/typecheck --filter=@bb/<pkg> for the packages you touch.",
        "Commit in that worktree as each slice is verified. Do not push.",
        "Comment on BBF-31 as you finish slices. Leave M0.5 to the other agent.",
        "Return a short report: files changed, tests run, commits, anything skipped.",
      ].join(" "),
      {
        label: "phase0-core",
        phase: "Implement",
        provider: "claude-code",
        model: "claude-sonnet-5",
        reasoningLevel: "medium",
      },
    ),
  () =>
    agent(
      [
        "You are the Phase 0 implementer for the Board plugin only.",
        "Read /tmp/bb-ui-review/PHASE-0-BRIEF.md section M0.5.",
        "Work ONLY in /Users/john.keeney/bb-plugins/bb-plugin-board.",
        "Do not edit /Users/john.keeney/bb or /Users/john.keeney/bb-wt/ui-phase0.",
        "Do not run pnpm reset or pnpm dev.",
        "Make the projects sidebar collapsible and default-collapsed below a desktop breakpoint so the 4th kanban column is not clipped at 1280/1512.",
        "Add or update a test if the plugin already has one. Commit in that repo if it is a git checkout; do not push.",
        "Comment on BBF-31 that M0.5 landed or why it could not.",
        "Return a short report: files changed, tests run, commits.",
      ].join(" "),
      {
        label: "phase0-board",
        phase: "Implement",
        provider: "codex",
        model: "gpt-5.6-terra",
        reasoningLevel: "medium",
      },
    ),
]);

phase("Review");
const review = await agent(
  [
    "Independently review the Phase 0 implementation. Read /tmp/bb-ui-review/PHASE-0-BRIEF.md.",
    "Inspect git diff in /Users/john.keeney/bb-wt/ui-phase0 (branch nsai/ui-phase-0) and any Board plugin changes in /Users/john.keeney/bb-plugins/bb-plugin-board.",
    "Do not implement unless you find a one-line correctness bug in the worktree. Do not edit /Users/john.keeney/bb.",
    "Check: retired threads excluded from sidebar bootstrap; hairline lighter than border; subtle text contrast; theme tests; Inbox loading/empty/error distinguishable; board column not clipped.",
    "Implementer reports:",
    "CORE: " + String(implemented[0] || "null"),
    "BOARD: " + String(implemented[1] || "null"),
    "Return findings (severity + file + why) and a ship/no-ship verdict for BBF-31.",
  ].join("\n"),
  {
    label: "phase0-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return {
  core: implemented[0] || null,
  board: implemented[1] || null,
  review: review || null,
};
