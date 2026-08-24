export const meta = {
  name: "ui-master-phase-5",
  description: "Implement UI Phase 5 command palette (BBF-36), then review.",
  phases: [
    { title: "Implement", detail: "Command palette + optional ask-agent empty" },
    { title: "Review", detail: "Ship/no-ship BBF-36" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-5-BRIEF.md. Work ONLY in /Users/john.keeney/bb-wt/ui-phase5.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Implement M5.1 and M5.2. Skip M5.3/M5.4 unless a thin re-export. Commit. Comment BBF-36.",
    "Return commits, files, tests, skipped.",
  ].join(" "),
  {
    label: "phase5-core",
    phase: "Implement",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review /Users/john.keeney/bb-wt/ui-phase5 against /tmp/bb-ui-review/PHASE-5-BRIEF.md.",
    "Implementer: " + String(implementation || "null"),
    "Findings first. Last line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase5-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { implementation: implementation || null, review: review || null };
