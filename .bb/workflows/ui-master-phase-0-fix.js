export const meta = {
  name: "ui-master-phase-0-fix",
  description:
    "Close the BBF-31 NO-SHIP findings on M0.3, then re-review Phase 0.",
  phases: [
    { title: "Fix", detail: "Raise subtle, use decoration, ban opacity on text" },
    { title: "Review", detail: "Re-check BBF-31 ship/no-ship" },
  ],
};

phase("Fix");
const fix = await agent(
  [
    "Read /tmp/bb-ui-review/PHASE-0-FIX-BRIEF.md and implement only those findings.",
    "Work ONLY in /Users/john.keeney/bb-wt/ui-phase0 on nsai/ui-phase-0.",
    "Do not edit /Users/john.keeney/bb. Do not pnpm reset or pnpm dev.",
    "Run pnpm exec turbo run test --filter=@bb/app -- apps/app/src/components/ui/theme.test.ts",
    "Typecheck --filter=@bb/app. Commit. Comment BBF-31.",
    "Return files changed, tests, commit hash.",
  ].join(" "),
  {
    label: "phase0-m03-fix",
    phase: "Fix",
    provider: "claude-code",
    model: "claude-sonnet-5",
    reasoningLevel: "medium",
  },
);

phase("Review");
const review = await agent(
  [
    "Re-review BBF-31 in /Users/john.keeney/bb-wt/ui-phase0.",
    "Previous NO-SHIP: subtle token unchanged, decoration unused, /75 text below AA, tests only check opaque tokens.",
    "Fix report: " + String(fix || "null"),
    "Read theme.css, theme.test.ts, and grep text-subtle-foreground/ in apps/app/src.",
    "Do not implement unless a one-line test fix. Verdict SHIP or NO-SHIP with findings.",
  ].join("\n"),
  {
    label: "phase0-rereview",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
  },
);

return { fix: fix || null, review: review || null };
