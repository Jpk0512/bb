export const meta = {
  name: "ui-master-phase-7",
  description: "Implement UI Phase 7 compact rail + responsive (BBF-38), then review.",
  phases: [
    { title: "Implement", detail: "Compact sidebar + narrow panel collapse" },
    { title: "Review", detail: "Ship/no-ship BBF-38" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-7-BRIEF.md. Work ONLY in /Users/john.keeney/bb-wt/ui-phase7.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Implement M7.1 and M7.3. Skip M7.2/M7.4. Commit. Comment BBF-38.",
    "Return commits, files, tests, skipped.",
  ].join(" "),
  {
    label: "phase7-core",
    phase: "Implement",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review /Users/john.keeney/bb-wt/ui-phase7 against /tmp/bb-ui-review/PHASE-7-BRIEF.md.",
    "Implementer: " + String(implementation || "null"),
    "Findings first. Last line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase7-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { implementation: implementation || null, review: review || null };
