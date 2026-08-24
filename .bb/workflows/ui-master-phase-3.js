export const meta = {
  name: "ui-master-phase-3",
  description:
    "Implement UI master-plan Phase 3 working set II (BBF-34), then review.",
  phases: [
    { title: "Implement", detail: "Working set, pin UX, home Continue" },
    { title: "Review", detail: "Ship/no-ship BBF-34" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-3-BRIEF.md and MASTER-IMPLEMENTATION.md Phase 3.",
    "Work ONLY in /Users/john.keeney/bb-wt/ui-phase3 on nsai/ui-phase-3.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Implement M3.1, M3.2, M3.4. Skip M3.3 live automation unless trivial. Commit. Comment BBF-34.",
    "Return commits, files, tests, skipped items.",
  ].join(" "),
  {
    label: "phase3-core",
    phase: "Implement",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review /Users/john.keeney/bb-wt/ui-phase3 against /tmp/bb-ui-review/PHASE-3-BRIEF.md.",
    "Implementer: " + String(implementation || "null"),
    "Do not implement. Write findings first, then last line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase3-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { implementation: implementation || null, review: review || null };
