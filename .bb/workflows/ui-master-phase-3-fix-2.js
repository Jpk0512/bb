export const meta = {
  name: "ui-master-phase-3-fix-2",
  description: "Second BBF-34 fix pass, then re-review.",
  phases: [
    { title: "Fix", detail: "Disclosure, pin replace, Continue fill, new-thread chrome" },
    { title: "Review", detail: "Re-check BBF-34" },
  ],
};

phase("Fix");
const fix = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-3-FIX-2-BRIEF.md and close every must-fix item.",
    "Work ONLY in /Users/john.keeney/bb-wt/ui-phase3. Do not edit /Users/john.keeney/bb.",
    "Do not pnpm reset or pnpm dev. Commit. Comment BBF-34.",
    "Return files, tests, commit hash.",
  ].join(" "),
  {
    label: "phase3-fix-2",
    phase: "Fix",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Re-review /Users/john.keeney/bb-wt/ui-phase3 against /tmp/bb-ui-review/PHASE-3-FIX-2-BRIEF.md.",
    "Fix report: " + String(fix || "null"),
    "Findings first. Last line VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase3-rereview-2",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { fix: fix || null, review: review || null };
