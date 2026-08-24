export const meta = {
  name: "ui-master-phase-1",
  description:
    "Implement UI master-plan Phase 1 design-system core (BBF-32), then review.",
  phases: [
    { title: "Implement", detail: "Tokens, switch, motion, FAB, primitives" },
    { title: "Review", detail: "Independent ship/no-ship on BBF-32" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-1-BRIEF.md and /tmp/bb-ui-review/MASTER-IMPLEMENTATION.md Phase 1.",
    "Work ONLY in /Users/john.keeney/bb-wt/ui-phase1 on nsai/ui-phase-1.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Implement M1.1 through M1.8. Skip M1.9 if Agentation source is not a writable checkout.",
    "Do not regress Phase 0 theme contrast tests or the text-subtle-foreground/ ban.",
    "Commit in the worktree. Comment BBF-32. Do not push.",
    "Return commits, files, tests, skipped items.",
  ].join(" "),
  {
    label: "phase1-core",
    phase: "Implement",
    provider: "claude-code",
    model: "claude-sonnet-5",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review Phase 1 in /Users/john.keeney/bb-wt/ui-phase1 against /tmp/bb-ui-review/PHASE-1-BRIEF.md.",
    "Implementer report: " + String(implementation || "null"),
    "Check switch checked color, motion tokens exist, contrast tests still pass, no new text-subtle-foreground/, FAB not a white unlabeled circle.",
    "Do not implement. Verdict SHIP or NO-SHIP with findings. You MUST end with a one-line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase1-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { implementation: implementation || null, review: review || null };
