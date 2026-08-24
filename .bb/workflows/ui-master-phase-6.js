export const meta = {
  name: "ui-master-phase-6",
  description: "Implement UI Phase 6 file tree tab only (BBF-37), then review.",
  phases: [
    { title: "Implement", detail: "Files tab in secondary panel" },
    { title: "Review", detail: "Ship/no-ship BBF-37" },
  ],
};

phase("Implement");
const implementation = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-6-BRIEF.md. Work ONLY in /Users/john.keeney/bb-wt/ui-phase6.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev. Do not bump HOST_DAEMON_PROTOCOL_VERSION.",
    "Implement M6.1 and M6.3 if small. Skip Monaco and write RPC. Commit. Comment BBF-37.",
    "Return commits, files, tests, skipped.",
  ].join(" "),
  {
    label: "phase6-core",
    phase: "Implement",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Review /Users/john.keeney/bb-wt/ui-phase6 against /tmp/bb-ui-review/PHASE-6-BRIEF.md.",
    "Implementer: " + String(implementation || "null"),
    "Fail if protocol version was bumped or monaco was half-added. Findings first. Last line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase6-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { implementation: implementation || null, review: review || null };
