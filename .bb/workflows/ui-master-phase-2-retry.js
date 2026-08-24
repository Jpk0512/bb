export const meta = {
  name: "ui-master-phase-2-retry",
  description:
    "Finish Phase 2 sidebar work after Claude OAuth died, then review.",
  phases: [
    { title: "Implement", detail: "Complete the uncommitted Phase 2 diff" },
    { title: "Review", detail: "Ship/no-ship BBF-33" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-2-CONTINUE.md and PHASE-2-BRIEF.md.",
    "Work ONLY in /Users/john.keeney/bb-wt/ui-phase2. Do not revert existing uncommitted files.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Finish M2.2-M2.5, commit, comment BBF-33. Do not push.",
    "Return commits, files, tests, skipped items.",
  ].join(" "),
  {
    label: "phase2-core-codex",
    phase: "Implement",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review /Users/john.keeney/bb-wt/ui-phase2 against /tmp/bb-ui-review/PHASE-2-BRIEF.md.",
    "Implementer: " + String(implementation || "null"),
    "Do not implement. Last line MUST be VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase2-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { implementation: implementation || null, review: review || null };
