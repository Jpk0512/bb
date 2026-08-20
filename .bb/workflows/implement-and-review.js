export const meta = {
  name: "implement-and-review",
  description:
    "Have Codex implement a task, then have Claude and Grok review the result.",
  phases: [
    { title: "Implement", detail: "Codex makes the change" },
    { title: "Review", detail: "Claude and Grok review independently" },
  ],
};

const task =
  args && typeof args === "object" && args.task
    ? String(args.task)
    : "Implement the next requested change.";

phase("Implement");
const implementation = await agent(
  "Implement this task in the current workspace. Use tools. Do not recap. Task: " +
    task,
  {
    label: "codex-implement",
    phase: "Implement",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningLevel: "medium",
  },
);

phase("Review");
const reviews = await parallel([
  () =>
    agent(
      "Review the implementation that was just made. Use tools. Implementation report:\n" +
        (implementation || "") +
        "\nOriginal task: " +
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
      "Review the implementation that was just made. Use tools. Implementation report:\n" +
        (implementation || "") +
        "\nOriginal task: " +
        task,
      {
        label: "grok-review",
        phase: "Review",
        provider: "acp-grok",
        model: "grok-4.5",
        reasoningLevel: "high",
      },
    ),
]);

return {
  implementation: implementation || null,
  claude: reviews[0] || null,
  grok: reviews[1] || null,
};
