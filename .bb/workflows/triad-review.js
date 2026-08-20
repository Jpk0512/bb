export const meta = {
  name: "triad-review",
  description:
    "Review a task independently with Claude, Grok, and Codex, then synthesize.",
  phases: [
    { title: "Review", detail: "One reviewer per provider" },
    { title: "Synthesize", detail: "Merge the three reviews" },
  ],
};

const task =
  args && typeof args === "object" && args.task
    ? String(args.task)
    : "Review the current workspace.";

phase("Review");
const reviews = await parallel([
  () =>
    agent(
      "Review this task for correctness and safety. Use tools to inspect the real files. Task: " +
        task,
      {
        label: "claude-review",
        phase: "Review",
        provider: "claude-code",
        model: "claude-opus-5[1m]",
        reasoningLevel: "high",
      },
    ),
  () =>
    agent(
      "Review this task for product and architecture fit. Use tools to inspect the real files. Task: " +
        task,
      {
        label: "grok-review",
        phase: "Review",
        provider: "acp-grok",
        model: "grok-4.5",
        reasoningLevel: "high",
      },
    ),
  () =>
    agent(
      "Review this task for implementation risk. Use tools to inspect the real files. Task: " +
        task,
      {
        label: "codex-review",
        phase: "Review",
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "medium",
      },
    ),
]);

const claude = reviews[0] || "(no Claude review)";
const grok = reviews[1] || "(no Grok review)";
const codex = reviews[2] || "(no Codex review)";

phase("Synthesize");
return await agent(
  "Synthesize these three reviews into one verdict. Call out conflicts.\n\nClaude:\n" +
    claude +
    "\n\nGrok:\n" +
    grok +
    "\n\nCodex:\n" +
    codex,
  { label: "synthesize", phase: "Synthesize" },
);
