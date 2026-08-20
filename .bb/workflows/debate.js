export const meta = {
  name: "debate",
  description:
    "Ask the same question of Claude, Grok, and Codex, have them rebut each other, then judge and record the verdict.",
  phases: [
    { title: "Opening", detail: "Each model answers independently" },
    { title: "Rebuttal", detail: "Each model reads the others and defends or concedes" },
    { title: "Verdict", detail: "Judge scores the exchange and synthesizes" },
    { title: "Record", detail: "Persist the debate to Recall as router training data" },
  ],
};

const question =
  args && typeof args === "object" && (args.question || args.task)
    ? String(args.question || args.task)
    : "State and defend the most important improvement to make in this workspace next.";

// Provider tuples must be literal at each call site (the validator checks them
// against the live catalog), so the seats are unrolled rather than looped.
// Each seat gets a distinct lens so the panel disagrees for real reasons
// instead of producing three paraphrases of one answer.
const CLAUDE = {
  id: "claude",
  name: "Claude",
  model: "claude-opus-5[1m]",
  lens: "correctness and safety — what breaks, what is subtly wrong, what the failure modes are",
};
const GROK = {
  id: "grok",
  name: "Grok",
  model: "grok-4.5",
  lens: "architecture and product fit — whether this is the right shape at all, and what it costs later",
};
const CODEX = {
  id: "codex",
  name: "Codex",
  model: "gpt-5.6-sol",
  lens: "implementation reality — effort, sequencing, and what actually has to change on disk",
};

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["position", "reasoning", "confidence", "keyRisk"],
  properties: {
    position: {
      type: "string",
      description: "The direct answer in at most 200 words. State a conclusion, not options.",
    },
    reasoning: {
      type: "string",
      description: "Why, grounded in specifics you verified with tools. Cite file paths or commands.",
    },
    confidence: {
      type: "number",
      description: "0-100. Be honest; low confidence is more useful than false certainty.",
    },
    keyRisk: {
      type: "string",
      description: "The single strongest argument AGAINST your own position.",
    },
  },
};

const REBUTTAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stance", "concededTo", "argument", "finalPosition"],
  properties: {
    stance: {
      enum: ["hold", "refine", "concede"],
      description:
        "hold = my position stands; refine = it stands with changes; concede = another position is better.",
    },
    concededTo: {
      type: "string",
      description: "If conceding or refining, which opponent moved you (Claude/Grok/Codex); otherwise an empty string.",
    },
    argument: {
      type: "string",
      description:
        "Engage the opponents' actual claims — name what they got right and what is wrong, with specifics. At most 250 words.",
    },
    finalPosition: {
      type: "string",
      description: "Your position after considering the others, in at most 150 words.",
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["winner", "answer", "scores", "unresolved"],
  properties: {
    winner: {
      type: "string",
      description: "Which seat argued the strongest case (Claude/Grok/Codex), or 'synthesis' if the truth is a merge.",
    },
    answer: {
      type: "string",
      description: "The actual answer to the question, written for the user. Decisive and specific.",
    },
    scores: {
      type: "array",
      description: "One entry per seat that participated.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seat", "correctness", "completeness", "riskAwareness", "note"],
        properties: {
          seat: { type: "string" },
          correctness: { type: "number", description: "0-10: is it factually right?" },
          completeness: { type: "number", description: "0-10: did it cover what matters?" },
          riskAwareness: { type: "number", description: "0-10: did it see the failure modes?" },
          note: { type: "string", description: "One line on what this seat uniquely contributed." },
        },
      },
    },
    unresolved: {
      type: "string",
      description: "What the panel could not settle and what evidence would settle it. Empty string if none.",
    },
  },
};

function openingPrompt(seat) {
  return [
    `Answer this question. Your lens is ${seat.lens}.`,
    "Use tools to verify against the real workspace before answering — do not speculate.",
    "You are one of three models answering independently; the others will read and challenge you.",
    "",
    `QUESTION: ${question}`,
  ].join("\n");
}

function render(seat, answer) {
  if (!answer) return `### ${seat.name}\n(no answer — agent failed)`;
  return [
    `### ${seat.name} (${seat.model})`,
    `Position: ${answer.position}`,
    `Reasoning: ${answer.reasoning}`,
    `Confidence: ${answer.confidence}`,
    `Strongest counter-argument to itself: ${answer.keyRisk}`,
  ].join("\n");
}

function rebuttalPrompt(seat, own, opponents) {
  return [
    "You answered a question. Two other models answered the same question independently.",
    "Read them and respond: defend your position, refine it, or concede — whichever the evidence supports.",
    "Conceding when another model is right is a correct outcome, not a loss. Do not restate your opening.",
    "Engage their specific claims. Verify with tools where you disagree on facts.",
    "",
    `QUESTION: ${question}`,
    "",
    "YOUR OPENING:",
    render(seat, own),
    "",
    "THE OTHERS:",
    opponents,
  ].join("\n");
}

// ---- Round 1: independent answers ------------------------------------------

phase("Opening");
const openings = await parallel([
  () =>
    agent(openingPrompt(CLAUDE), {
      label: "open:claude",
      phase: "Opening",
      provider: "claude-code",
      model: "claude-opus-5[1m]",
      reasoningLevel: "high",
      schema: ANSWER_SCHEMA,
    }),
  () =>
    agent(openingPrompt(GROK), {
      label: "open:grok",
      phase: "Opening",
      provider: "acp-grok",
      model: "grok-4.5",
      reasoningLevel: "high",
      schema: ANSWER_SCHEMA,
    }),
  () =>
    agent(openingPrompt(CODEX), {
      label: "open:codex",
      phase: "Opening",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "medium",
      schema: ANSWER_SCHEMA,
    }),
]);

const seats = [
  { seat: CLAUDE, answer: openings[0] },
  { seat: GROK, answer: openings[1] },
  { seat: CODEX, answer: openings[2] },
];
const answered = seats.filter((entry) => entry.answer);
log(`${answered.length}/3 seats answered the opening round`);
for (const entry of seats) {
  if (!entry.answer) log(`dropped: ${entry.seat.name} produced no opening answer`);
}

if (answered.length === 0) {
  return { question, error: "no seat produced an opening answer", verdict: null };
}

function othersFor(id) {
  return answered
    .filter((entry) => entry.seat.id !== id)
    .map((entry) => render(entry.seat, entry.answer))
    .join("\n\n");
}

// ---- Round 2: rebuttals ----------------------------------------------------
// A seat only rebuts if it answered. Each rebuttal depends on round 1 as a
// whole, so the barrier above is the correct shape here.

phase("Rebuttal");
const claudeAnswer = seats[0].answer;
const grokAnswer = seats[1].answer;
const codexAnswer = seats[2].answer;

const rebuttals = await parallel([
  () =>
    claudeAnswer
      ? agent(rebuttalPrompt(CLAUDE, claudeAnswer, othersFor("claude")), {
          label: "rebut:claude",
          phase: "Rebuttal",
          provider: "claude-code",
          model: "claude-opus-5[1m]",
          reasoningLevel: "high",
          schema: REBUTTAL_SCHEMA,
        })
      : Promise.resolve(null),
  () =>
    grokAnswer
      ? agent(rebuttalPrompt(GROK, grokAnswer, othersFor("grok")), {
          label: "rebut:grok",
          phase: "Rebuttal",
          provider: "acp-grok",
          model: "grok-4.5",
          reasoningLevel: "high",
          schema: REBUTTAL_SCHEMA,
        })
      : Promise.resolve(null),
  () =>
    codexAnswer
      ? agent(rebuttalPrompt(CODEX, codexAnswer, othersFor("codex")), {
          label: "rebut:codex",
          phase: "Rebuttal",
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoningLevel: "medium",
          schema: REBUTTAL_SCHEMA,
        })
      : Promise.resolve(null),
]);

const exchange = seats
  .map((entry, index) => ({ ...entry, rebuttal: rebuttals[index] }))
  .filter((entry) => entry.answer);

// ---- Round 3: verdict ------------------------------------------------------

phase("Verdict");
const transcript = exchange
  .map((entry) =>
    [
      render(entry.seat, entry.answer),
      entry.rebuttal
        ? [
            `Rebuttal — stance: ${entry.rebuttal.stance}${
              entry.rebuttal.concededTo ? ` (moved by ${entry.rebuttal.concededTo})` : ""
            }`,
            entry.rebuttal.argument,
            `Final position: ${entry.rebuttal.finalPosition}`,
          ].join("\n")
        : "Rebuttal: (none)",
    ].join("\n"),
  )
  .join("\n\n---\n\n");

// The judge inherits the origin thread's model on purpose: selection overrides
// must be complete tuples, and an inherited judge is not one of the seats'
// configured personas.
const verdict = await agent(
  [
    "You are judging a multi-model debate. Score each seat and give the user the actual answer.",
    "Judge the arguments, not the model names. A seat that conceded well may still score highly.",
    "Where the panel agreed, say so plainly. Where it split, pick a side and say why — do not hedge.",
    "If the truth is a merge of positions, set winner to 'synthesis'.",
    "",
    `QUESTION: ${question}`,
    "",
    "THE EXCHANGE:",
    transcript,
  ].join("\n"),
  { label: "judge", phase: "Verdict", schema: VERDICT_SCHEMA },
);

// ---- Record ----------------------------------------------------------------
// Debates are the highest-signal rows this system produces: one question,
// several models, a judged outcome. The Phase 6 router trains on them.

phase("Record");
const held = exchange.filter((entry) => entry.rebuttal && entry.rebuttal.stance === "hold").length;
const consensus = `${held}/${exchange.length} held their opening position`;

// `bb recall add --details` caps at 8000 characters, so the record is a
// bounded structured digest — positions, stances and scores, which is what
// the router will train on — not the raw exchange. The full prose stays in
// the workflow run history, which is already durable and paged.
function clip(value, max) {
  const text = String(value == null ? "" : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const scoreLines = (verdict && verdict.scores ? verdict.scores : []).map(
  (score) =>
    `- ${score.seat}: correctness ${score.correctness}, completeness ${score.completeness}, risk ${score.riskAwareness} — ${clip(score.note, 220)}`,
);

const seatLines = exchange.flatMap((entry) => [
  `- ${entry.seat.name} (${entry.seat.model}) · confidence ${
    entry.answer ? entry.answer.confidence : "?"
  } · stance ${entry.rebuttal ? entry.rebuttal.stance : "none"}${
    entry.rebuttal && entry.rebuttal.concededTo ? ` → ${entry.rebuttal.concededTo}` : ""
  }`,
  `    opened: ${clip(entry.answer ? entry.answer.position : "", 400)}`,
  `    final:  ${clip(entry.rebuttal ? entry.rebuttal.finalPosition : "", 400)}`,
]);

const recordBody = [
  `Question: ${clip(question, 600)}`,
  "",
  `Winner: ${verdict ? verdict.winner : "unknown"}`,
  `Consensus: ${consensus}`,
  "",
  `Verdict: ${clip(verdict ? verdict.answer : "(judge failed)", 2600)}`,
  "",
  `Unresolved: ${clip(verdict && verdict.unresolved ? verdict.unresolved : "none", 600)}`,
  "",
  "Seats:",
  ...seatLines,
  "",
  "Scores:",
  ...scoreLines,
  "",
  "Full exchange: see this workflow run's history (bb workflows history <run-id>).",
].join("\n");

// Hard stop under the store's limit; the pieces above are already bounded,
// so this only fires if a judge returns something pathological.
const boundedBody = clip(recordBody, 7600);

// Persisted through the structured `recall_save` tool, never a shell command.
// A heredoc here carried a static delimiter around a model-authored body, so
// output containing that delimiter could terminate the document early and let
// the remainder run as shell. A tool argument has no such transport to escape.
await agent(
  [
    "Persist this debate digest to Recall using the `recall_save` tool.",
    "Do NOT use a shell command, `bb recall add`, a heredoc, or any other text transport — call the tool directly.",
    "",
    "Arguments:",
    "  scope:   project",
    "  kind:    decision",
    "  title:   a short title naming the question",
    "  summary: the verdict answer in one or two sentences, under 400 characters",
    "  tags:    [\"debate\"]",
    "  reason:  multi-model debate verdict",
    "  details: the entire BODY below, copied verbatim",
    "",
    "The body is already clipped to fit Recall's 8000-character details limit — do not edit,",
    "summarize, reformat, or truncate it. If the tool rejects the call, report the exact error",
    "and do not retry with a shortened body.",
    "",
    "BODY:",
    boundedBody,
  ].join("\n"),
  { label: "record", phase: "Record" },
);

return {
  question,
  consensus,
  seats: exchange.map((entry) => ({
    seat: entry.seat.name,
    model: entry.seat.model,
    position: entry.answer ? entry.answer.position : null,
    confidence: entry.answer ? entry.answer.confidence : null,
    stance: entry.rebuttal ? entry.rebuttal.stance : null,
    concededTo: entry.rebuttal && entry.rebuttal.concededTo ? entry.rebuttal.concededTo : null,
    finalPosition: entry.rebuttal ? entry.rebuttal.finalPosition : null,
  })),
  verdict: verdict || null,
};
