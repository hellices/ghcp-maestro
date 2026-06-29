// Concurrency primitives — zero deps.
//
// Provides a lightweight semaphore + concurrency-limited Promise.all-style
// helper used by the workflow runtime. No timers, no microtask hacks; just
// a FIFO queue of waiters drained as permits become available.

/**
 * Counting semaphore. Acquire returns a release function; the caller MUST
 * call release exactly once (typically in a try/finally).
 *
 * @param {number} permits Maximum concurrent holders. Must be a positive integer.
 */
export function createSemaphore(permits) {
  if (!Number.isInteger(permits) || permits <= 0) {
    throw new TypeError(`createSemaphore: permits must be a positive integer (got ${permits})`);
  }
  let available = permits;
  const waiters = [];

  function acquire() {
    if (available > 0) {
      available -= 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        available -= 1;
        resolve(release);
      });
    });
  }

  function release() {
    available += 1;
    if (waiters.length > 0 && available > 0) {
      const next = waiters.shift();
      next();
    }
  }

  return {
    acquire,
    get available() {
      return available;
    },
    get pending() {
      return waiters.length;
    },
  };
}

/**
 * Run an array of async tasks with a hard concurrency cap. Results are
 * returned in input order. If any task rejects the returned promise rejects
 * with the first error, but in-flight tasks are awaited (no cancellation).
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks  Thunks that start the work when called.
 * @param {{ concurrency: number, signal?: AbortSignal }} opts
 * @returns {Promise<T[]>}
 */
export async function runWithConcurrency(tasks, opts) {
  const concurrency = opts?.concurrency;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new TypeError(`runWithConcurrency: concurrency must be a positive integer (got ${concurrency})`);
  }
  if (!Array.isArray(tasks)) {
    throw new TypeError("runWithConcurrency: tasks must be an array");
  }
  const signal = opts?.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  const sem = createSemaphore(Math.min(concurrency, Math.max(tasks.length, 1)));
  const results = new Array(tasks.length);
  let firstError;

  await Promise.all(
    tasks.map(async (task, index) => {
      const release = await sem.acquire();
      try {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("aborted");
        }
        if (firstError !== undefined) {
          // Earlier task failed; skip remaining starts but keep in-flight running.
          return;
        }
        if (typeof task !== "function") {
          throw new TypeError(`runWithConcurrency: tasks[${index}] is not a function`);
        }
        results[index] = await task();
      } catch (err) {
        if (firstError === undefined) firstError = err;
      } finally {
        release();
      }
    }),
  );

  if (firstError !== undefined) throw firstError;
  return results;
}
