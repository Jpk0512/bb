export const meta = {
  name: "ui-master-phase-3-fix",
  description: "Close BBF-34 NO-SHIP findings, then re-review.",
  phases: [
    { title: "Fix", detail: "Working-set cap, buckets, pin replace, Continue" },
    { title: "Review", detail: "Re-check BBF-34" },
  ],
};

phase("Fix");
const fix = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-3-FIX-BRIEF.md and implement every blocker and high finding.",
    "Work ONLY in /Users/john.keeney/bb-wt/ui-phase3. Do not edit /Users/john.keeney/bb.",
    "Do not pnpm reset or pnpm dev. Commit. Comment BBF-34.",
    "Return files, tests, commit hash.",
  ].join(" "),
  {
    label: "phase3-fix",
    phase: "Fix",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Re-review /Users/john.keeney/bb-wt/ui-phase3 against /tmp/bb-ui-review/PHASE-3-FIX-BRIEF.md.",
    "Fix report: " + String(fix || "null"),
    "Write findings first. Last line MUST be VERDICT: SHIP or VERDICT: NO-SHIP.",
  ].join("\n"),
  {
    label: "phase3-rereview",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { fix: fix || null, review: review || null };
