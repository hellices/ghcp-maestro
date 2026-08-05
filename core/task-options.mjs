export const WRITE_FLAG = "--write";
export const ALLOW_DIRTY_FLAG = "--allow-dirty";
export const AGENTS_FLAG = "--agents";
export const CONCURRENCY_FLAG = "--concurrency";
export const MIN_EXPLICIT_AGENTS = 1;
export const MAX_EXPLICIT_AGENTS = 50;
export const MIN_TASK_CONCURRENCY = 1;
export const MAX_TASK_CONCURRENCY = 16;

const LEADING_OPTION_RE =
  /^(?:(--write|--allow-dirty)(?=\s|$)|(--agents|--concurrency)\s+(\S+)(?=\s|$))(?:\s+|$)/;
const TRAILING_OPTION_RE =
  /(?:^|\s)(?:(--write|--allow-dirty)|(--agents|--concurrency)\s+(\S+))$/;

export function parseTaskOptions(raw, overrides = {}) {
  const parsed = parseEdgeOptions(String(raw ?? ""));
  const options = {
    ...parsed,
    write: overrides.write ?? parsed.write,
    allowDirty: overrides.allowDirty ?? parsed.allowDirty,
    agents: overrides.agents ?? parsed.agents,
    concurrency: overrides.concurrency ?? parsed.concurrency,
  };
  validateRange(AGENTS_FLAG, options.agents, MIN_EXPLICIT_AGENTS, MAX_EXPLICIT_AGENTS);
  validateRange(
    CONCURRENCY_FLAG,
    options.concurrency,
    MIN_TASK_CONCURRENCY,
    MAX_TASK_CONCURRENCY,
  );
  if (!options.task) throw new Error("task options: task description is required");
  return options;
}

export function serializeTaskOptions(options) {
  return [
    options.agents === undefined ? null : `${AGENTS_FLAG} ${options.agents}`,
    options.concurrency === undefined ? null : `${CONCURRENCY_FLAG} ${options.concurrency}`,
    options.write ? WRITE_FLAG : null,
    options.allowDirty ? ALLOW_DIRTY_FLAG : null,
    options.task,
  ]
    .filter(Boolean)
    .join(" ");
}

function parseEdgeOptions(raw) {
  const state = {
    task: raw.trim(),
    write: false,
    allowDirty: false,
    agents: undefined,
    concurrency: undefined,
  };
  const seen = new Set();
  const take = (name, rawValue) => {
    if (seen.has(name)) throw new Error(`task options: duplicate ${name}`);
    seen.add(name);
    if (name === WRITE_FLAG) state.write = true;
    else if (name === ALLOW_DIRTY_FLAG) state.allowDirty = true;
    else {
      const value = Number(rawValue);
      if (!Number.isInteger(value)) {
        throw new Error(`task options: ${name} must be an integer`);
      }
      if (name === AGENTS_FLAG) state.agents = value;
      else state.concurrency = value;
    }
  };

  let match;
  while ((match = state.task.match(LEADING_OPTION_RE))) {
    take(match[1] ?? match[2], match[3]);
    state.task = state.task.slice(match[0].length);
  }
  while ((match = state.task.match(TRAILING_OPTION_RE))) {
    take(match[1] ?? match[2], match[3]);
    state.task = state.task.slice(0, match.index).trimEnd();
  }
  state.task = state.task.trim();
  return state;
}

function validateRange(name, value, min, max) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`task options: ${name} must be an integer in the range ${min}-${max}`);
  }
}
