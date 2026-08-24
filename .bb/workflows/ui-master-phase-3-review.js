export const meta = {
  name: "ui-master-phase-3-review",
  description: "Review-only pass of BBF-34 after orchestrator fixes.",
  phases: [{ title: "Review", detail: "Ship/no-ship BBF-34" }],
};

phase("Review");
const review = await agent(
  [
    "Review /Users/john.keeney/bb-wt/ui-phase3 against /tmp/bb-ui-review/PHASE-3-FIX-2-BRIEF.md.",
    "Latest commit should include per-project older disclosures, pinReplaceInFlightRef, Continue live-then-idle fill, WorkingSetSections actions.",
    "Do not implement. Findings first. Last line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase3-rereview-3",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { review: review || null };
