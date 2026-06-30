// Example saved workflow — "deep-review".
//
// Usage:
//   /maestro run deep-review {"topic":"adopt event sourcing for orders"}
//   /maestro run deep-review should we rewrite the parser in Rust
//
// Demonstrates the M6 quality helpers wired through the injected `api`:
//   1. multiAngle drafts the question from several angles and a judge picks one
//   2. adversarialReview stress-tests the resulting key claims
//
// The script only uses the injected api — no fs, no shell, no direct SDK.

export const description =
  "Draft a question from multiple angles, judge the best, then adversarially review its claims.";

export default async function run(api) {
  const { args, log, multiAngle, adversarialReview, phase } = api;

  const topic = (args.topic ?? args.input ?? "").trim();
  if (!topic) {
    await log("deep-review needs a topic. Example: /maestro run deep-review {\"topic\":\"...\"}", {
      level: "warning",
    });
    return;
  }

  await log(`deep-review: "${topic.slice(0, 100)}"`);

  const { drafts, choice } = await phase("multi-angle", () =>
    multiAngle(topic, { angles: ["pragmatic", "skeptical", "long-term"] }),
  );
  await log(`multi-angle produced ${drafts.length} draft(s); chosen index=${choice.index}`);
  await log(`CHOSEN ANSWER ↓\n${choice.text || "(empty)"}`);

  // Derive a few claims from the chosen answer (first non-empty lines) and
  // adversarially review them.
  const claims = (choice.text || "")
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter((l) => l.length > 12)
    .slice(0, 3);

  if (claims.length === 0) {
    await log("no reviewable claims extracted; done.");
    return;
  }

  const { survivors, reviewed } = await phase("adversarial-review", () =>
    adversarialReview(claims, { reviewers: 3 }),
  );
  await log(
    `adversarial-review: ${survivors.length}/${reviewed.length} claim(s) survived (threshold 0.5)`,
  );
  for (const r of reviewed) {
    await log(`  [${r.survived ? "KEEP" : "DROP"}] score=${r.score.toFixed(2)} ${r.text.slice(0, 80)}`);
  }
}
