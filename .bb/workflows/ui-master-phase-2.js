export const meta = {
  name: "ui-master-phase-2",
  description:
    "Implement UI master-plan Phase 2 sidebar working set I (BBF-33), then review.",
  phases: [
    { title: "Implement", detail: "Sidebar hierarchy, status dots, grouping" },
    { title: "Review", detail: "Independent ship/no-ship on BBF-33" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-2-BRIEF.md and MASTER-IMPLEMENTATION.md Phase 2.",
    "Work ONLY in /Users/john.keeney/bb-wt/ui-phase2 on nsai/ui-phase-2.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Implement M2.2, M2.3, M2.4, M2.5. M2.1 glyph only if data exists. Skip M2.6/M2.7 if not in-repo.",
    "Commit. Comment BBF-33. Do not push.",
    "Return commits, files, tests, skipped items.",
  ].join(" "),
  {
    label: "phase2-core",
    phase: "Implement",
    provider: "claude-code",
    model: "claude-sonnet-5",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review Phase 2 in /Users/john.keeney/bb-wt/ui-phase2 against /tmp/bb-ui-review/PHASE-2-BRIEF.md.",
    "Implementer report: " + String(implementation || "null"),
    "Do not implement. End with exactly one line: VERDICT: SHIP or VERDICT: NO-SHIP.",
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
