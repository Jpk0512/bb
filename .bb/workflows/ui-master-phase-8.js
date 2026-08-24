export const meta = {
  name: "ui-master-phase-8",
  description: "Implement UI Phase 8 polish slice (BBF-39), then review.",
  phases: [
    { title: "Implement", detail: "Copy, picker labels, working title" },
    { title: "Review", detail: "Ship/no-ship BBF-39" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-8-BRIEF.md. Work ONLY in /Users/john.keeney/bb-wt/ui-phase8.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Implement M8.1, M8.10, M8.6. Commit. Comment BBF-39.",
    "Return commits, files, tests, skipped.",
  ].join(" "),
  {
    label: "phase8-core",
    phase: "Implement",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review /Users/john.keeney/bb-wt/ui-phase8 against /tmp/bb-ui-review/PHASE-8-BRIEF.md.",
    "Implementer: " + String(implementation || "null"),
    "Findings first. Last line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase8-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { implementation: implementation || null, review: review || null };
