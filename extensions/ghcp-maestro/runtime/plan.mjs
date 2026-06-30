// Plan generation + parsing for the M4 dynamic task workflow.
//
// These functions are pure (no SDK, no IO) so they can be unit-tested directly
// and reused by both the CLI extension and the future VS Code surface.

/** Minimum / maximum number of subtasks a plan may decompose into. */
export const MIN_PLAN_ENTRIES = 3;
export const MAX_PLAN_ENTRIES = 6;

/** Hard caps that keep child-session prompts focused and cheap. */
export const MAX_AGENT_NAME_LEN = 60;
export const MAX_PROMPT_LEN = 4_000;

/**
 * Build the meta-prompt asked of the `plan` agent. When `parserError` is
 * supplied the prompt becomes a corrective retry that echoes the parser
 * feedback and the previous (rejected) reply.
 *
 * @param {string} task
 * @param {string} [parserError]
 * @param {string} [previousReply]
 * @returns {string}
 */
export function buildPlanPrompt(task, parserError, previousReply) {
  const lines = [
    "You are a planning agent for a dynamic multi-agent workflow runtime.",
    "Decompose the following task into 3 to 6 INDEPENDENT subtasks that can run in parallel without seeing each other's output.",
    "Each subtask runs in its own isolated Copilot session — there is no shared state, no chat history, no working directory you can rely on. Subtasks must therefore be self-contained: include any context they need inside the prompt itself.",
    "",
    "Reply with ONLY a JSON array. No prose, no markdown fences, no commentary. Schema:",
    '[ { "agent": "<short kebab-case id, unique>", "prompt": "<self-contained instruction>" }, ... ]',
    "",
    "Rules:",
    `- ${MIN_PLAN_ENTRIES} <= length <= ${MAX_PLAN_ENTRIES}`,
    "- Every entry MUST have non-empty string `agent` and `prompt`",
    "- `agent` values MUST be unique within the array",
    "- Each `prompt` should produce a focused, finite answer in 1-2 short paragraphs or a small list. No open-ended exploration.",
    "- Cover the task from genuinely different angles; do not duplicate.",
    "",
    `Task: ${task}`,
  ];
  if (parserError) {
    lines.push(
      "",
      "Your previous reply could not be parsed. Parser error:",
      parserError,
      "",
      "Previous reply (for reference, do NOT repeat the same mistake):",
      previousReply ? previousReply.slice(0, 800) : "(empty)",
      "",
      "Return only the corrected JSON array, nothing else.",
    );
  }
  return lines.join("\n");
}

/**
 * Parse and validate a plan agent's raw reply into a normalized spec array.
 * Tolerant of markdown fences, surrounding chatter, and trailing commas.
 * Throws an Error with a human-readable message on any schema violation.
 *
 * @param {string} text
 * @returns {{ agent: string, prompt: string }[]}
 */
export function parseAndValidatePlan(text) {
  if (!text) throw new Error("empty plan response");
  let body = text.trim();

  // Strip optional markdown fence wrappers — both multi-line and single-line.
  // 1) ```json\n …\n ```        (block fence)
  const blockFence = body.match(/^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?\s*```$/i);
  if (blockFence) {
    body = blockFence[1].trim();
  } else {
    // 2) ``` … ```  (single-line fence)
    const inlineFence = body.match(/^```(?:json|jsonc)?\s*([\s\S]*?)\s*```$/i);
    if (inlineFence) body = inlineFence[1].trim();
  }

  // Locate the outermost JSON array.
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `response does not contain a JSON array: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`,
    );
  }
  let jsonText = body.slice(start, end + 1);
  // Tolerate trailing commas — common LLM mistake (`{"a":1,}` or `[1,2,]`).
  // Only strips commas immediately before `]` / `}` so we don't mutilate valid JSON.
  jsonText = jsonText.replace(/,(\s*[}\]])/g, "$1");

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`JSON.parse failed: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("plan must be an array");
  if (parsed.length < MIN_PLAN_ENTRIES || parsed.length > MAX_PLAN_ENTRIES) {
    throw new Error(
      `plan must have ${MIN_PLAN_ENTRIES}-${MAX_PLAN_ENTRIES} entries, got ${parsed.length}`,
    );
  }
  const seen = new Set();
  const normalized = [];
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`entry ${i} is not an object`);
    }
    if (typeof entry.agent !== "string" || entry.agent.trim() === "") {
      throw new Error(`entry ${i} missing string "agent"`);
    }
    if (typeof entry.prompt !== "string" || entry.prompt.trim() === "") {
      throw new Error(`entry ${i} missing string "prompt"`);
    }
    const agent = entry.agent.trim();
    if (agent.length > MAX_AGENT_NAME_LEN) {
      throw new Error(
        `entry ${i} agent name too long (max ${MAX_AGENT_NAME_LEN} chars): ${agent.slice(0, 80)}…`,
      );
    }
    if (seen.has(agent)) throw new Error(`duplicate agent name: ${agent}`);
    seen.add(agent);

    const prompt = entry.prompt.trim();
    if (prompt.length > MAX_PROMPT_LEN) {
      throw new Error(
        `entry ${i} (${agent}) prompt is ${prompt.length} chars — must be <= ${MAX_PROMPT_LEN} to keep child-session prompts focused`,
      );
    }
    normalized.push({ agent, prompt });
  }
  return normalized;
}

/**
 * Make an agent name safe for use as a filesystem-friendly agent id.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeAgentName(name) {
  return name.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 40) || "agent";
}
