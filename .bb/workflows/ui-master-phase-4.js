export const meta = {
  name: "ui-master-phase-4",
  description: "Implement UI Phase 4 session chrome (BBF-35), then review.",
  phases: [
    { title: "Implement", detail: "Mono rows, hover overflow, header" },
    { title: "Review", detail: "Ship/no-ship BBF-35" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-4-BRIEF.md. Work ONLY in /Users/john.keeney/bb-wt/ui-phase4.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Implement the Must items. Commit. Comment BBF-35.",
    "Return commits, files, tests, skipped.",
  ].join(" "),
  {
    label: "phase4-core",
    phase: "Implement",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review /Users/john.keeney/bb-wt/ui-phase4 against /tmp/bb-ui-review/PHASE-4-BRIEF.md.",
    "Implementer: " + String(implementation || "null"),
    "Findings first. Last line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase4-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { implementation: implementation || null, review: review || null };
