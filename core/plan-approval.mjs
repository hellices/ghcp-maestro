// Plan pre-approval gate (M4.x).
//
// After the `plan` agent decomposes a task into subtasks, but BEFORE the
// expensive fan-out (N parallel child sessions), give the user a chance to
// review the subtask list + prompt previews and approve — or drop a subset,
// or abort. The gate is decoupled from the host session so it can be unit
// tested with a fake `ui`:
//
//   const { approved, selected } = await planApprovalGate({
//     specs, ui: session.ui, capabilities: session.capabilities, log,
//   });
//
// Safety: the interactive dialog only runs when the host actually supports
// elicitation (`capabilities.ui.elicitation === true`) AND auto-approve is
// off. Non-interactive hosts (env probes, CI, headless) and an explicit
// `autoApprove` bypass approve every subtask so existing automated paths keep
// working.

/**
 * @typedef {{ agent: string, prompt?: string }} PlanSpec
 * @typedef {{
 *   specs: PlanSpec[],
 *   ui?: { elicitation: (params: object) => Promise<{ action: string, content?: object }> } | null,
 *   capabilities?: { ui?: { elicitation?: boolean } },
 *   autoApprove?: boolean,
 *   estimate?: string,
 *   log?: (message: string, options?: object) => Promise<void> | void,
 * }} PlanApprovalOptions
 * @typedef {{ approved: boolean, selected: PlanSpec[], reason: string }} PlanApprovalResult
 */

/**
 * Gate the fan-out on user approval. Resolves to `{ approved, selected, reason }`.
 *
 * @param {PlanApprovalOptions} opts
 * @returns {Promise<PlanApprovalResult>}
 */
export async function planApprovalGate(opts = {}) {
  const { ui, capabilities, autoApprove = false, estimate, log } = opts;
  const all = Array.isArray(opts.specs) ? opts.specs : [];
  const note = async (msg, options) => {
    if (typeof log === "function") await log(msg, options);
  };

  if (autoApprove) {
    await note(`plan approval skipped (auto-approve): ${all.length} subtask(s)`);
    return { approved: true, selected: all, reason: "auto-approve" };
  }
  if (!ui || capabilities?.ui?.elicitation !== true) {
    await note(`plan approval skipped (non-interactive host): ${all.length} subtask(s)`);
    return { approved: true, selected: all, reason: "non-interactive" };
  }

  await note(
    `plan ready: ${all.length} subtask(s)${estimate ? ` — ${estimate}` : ""} — review before fan-out:`,
  );
  for (const s of all) {
    await note(`  • ${s.agent}: ${promptPreview(s.prompt)}`);
  }

  let result;
  try {
    result = await ui.elicitation(buildApprovalElicitation(all, estimate));
  } catch (err) {
    // The host claimed elicitation support but the dialog failed. Fail closed:
    // never fan out N child sessions without explicit consent.
    const reason = `error: ${err?.message ?? err}`;
    await note(`plan approval failed: ${reason}`, { level: "error" });
    return { approved: false, selected: [], reason };
  }
  const action = result?.action;
  if (action === "accept") {
    // Selections come back as stable per-subtask index keys ("0".."n-1"), not
    // agent names — duplicate agent names would otherwise collapse and approve
    // every spec that shares a name.
    const chosen = new Set(
      Array.isArray(result?.content?.subtasks) ? result.content.subtasks.map(String) : [],
    );
    const selected = all.filter((_, i) => chosen.has(String(i)));
    if (selected.length === 0) {
      return { approved: false, selected: [], reason: "empty-selection" };
    }
    return { approved: true, selected, reason: "approved" };
  }
  if (action === "decline") return { approved: false, selected: [], reason: "declined" };
  if (action === "cancel") return { approved: false, selected: [], reason: "cancelled" };
  return { approved: false, selected: [], reason: "rejected" };
}

function promptPreview(prompt) {
  return String(prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function buildApprovalElicitation(specs, estimate) {
  // Stable index keys keep duplicate agent names distinct; enumNames carries the
  // human-readable agent label the host shows next to each checkbox.
  const keys = specs.map((_, i) => String(i));
  const labels = specs.map((s) => s.agent);
  return {
    message: `Plan ready: ${specs.length} subtask(s).${estimate ? ` ${estimate}.` : ""} Select which to run, then Accept (Decline to abort).`,
    requestedSchema: {
      type: "object",
      properties: {
        subtasks: {
          type: "array",
          title: "Subtasks to run",
          description: "Deselect any subtask you want to skip.",
          items: { type: "string", enum: keys, enumNames: labels },
          default: keys,
        },
      },
      required: ["subtasks"],
    },
  };
}
