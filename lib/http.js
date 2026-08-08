// Unified transport kernel: timeouts, caller-opt-in retries with exponential
// backoff, Retry-After awareness and a concurrency semaphore. Zero runtime
// dependencies so every extension module can share the same network policy.

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_MAX_RETRY_AFTER_MS = 10000;

/** Statuses that are safe to retry when the caller opts into retries. */
export const RETRYABLE_STATUSES = Object.freeze(new Set([429, 502, 503, 504]));

export function createTimeoutError(timeoutMs) {
  const error = new Error(`请求超时（${timeoutMs}ms 内未收到响应）`);
  error.name = "TimeoutError";
  return error;
}

export function createAbortError(message = "请求已停止") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Bounded concurrency gate. `run(task)` executes at most `limit` tasks at a
 * time; `acquire()` resolves with an idempotent release function for manual
 * control. Waiting tasks keep FIFO order.
 */
export function createSemaphore(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("并发上限必须是正整数");
  }
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    queue.shift()();
  };

  const acquire = () => new Promise((resolve) => {
    queue.push(() => {
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        next();
      });
    });
    next();
  });

  const run = async (task) => {
    const release = await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };

  return {
    acquire,
    run,
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    }
  };
}

/** Resolves after `ms`, rejecting immediately with AbortError if `signal` aborts. */
export function waitInterruptible(ms, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let onAbort = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function backoffDelayMs(attempt, baseMs) {
  return baseMs * 2 ** attempt + Math.random() * baseMs;
}

/**
 * Parses `Retry-After` in either legal form: delta-seconds or HTTP-date.
 * The wait is capped at `maxRetryAfterMs` (default 10s) so callers can bound
 * latency; pass a larger cap to honor stricter server rate limits.
 */
function parseRetryAfterMs(response, maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS) {
  const header = response?.headers?.get?.("Retry-After");
  if (header === null || header === undefined) return null;
  const text = String(header).trim();
  if (!text) return null;
  let delayMs;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    delayMs = seconds * 1000;
  } else {
    const dateMs = Date.parse(text);
    if (Number.isNaN(dateMs)) return null;
    delayMs = dateMs - Date.now();
  }
  if (delayMs < 0) delayMs = 0;
  const cap = Number.isFinite(maxRetryAfterMs) && maxRetryAfterMs >= 0
    ? maxRetryAfterMs
    : DEFAULT_MAX_RETRY_AFTER_MS;
  return Math.min(delayMs, cap);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

/**
 * Races `promise` against the controller's abort so body consumption cannot
 * outlive the request: callers whose readers ignore signals (e.g. plain
 * `response.text()` mocks or stalled streams) still fail fast on abort.
 */
function abortAware(promise, controller) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        controller.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        controller.signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function singleAttempt(url, fetchOptions, externalSignal, timeoutMs, onBody) {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs)
    : null;
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    if (!onBody) return { response };
    // Body consumption stays inside the same controller lifecycle, so the
    // timeout and the external abort also cover a stalled response body.
    const value = await abortAware(onBody(response), controller);
    return { response, value };
  } catch (error) {
    // User-initiated abort always wins over the internal timeout so callers
    // can keep distinguishing "停止" from "超时".
    if (externalSignal?.aborted) return { aborted: true };
    if (timedOut) return { timeout: true };
    return { error };
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * fetch with policy. Recognized policy options (everything else is forwarded
 * to fetch): `timeoutMs`, `signal`, `retryable`, `maxRetries`, `backoffMs`,
 * `semaphore`, `consume`, `maxRetryAfterMs`. Retries only happen when
 * `retryable: true`, and only for 429/502/503/504 or network errors; an
 * aborted external signal is never retried. When `consume` is provided it
 * reads the body inside the request's timeout/abort umbrella and its return
 * value is resolved instead of the raw Response (retryable statuses are never
 * consumed before a retry). Without `consume`, the final Response is returned
 * and callers still inspect `response.ok`.
 */
export async function fetchWithPolicy(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryable = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    semaphore = null,
    consume = null,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    signal,
    ...fetchOptions
  } = options || {};

  const execute = async () => {
    const maxAttempts = retryable ? Math.max(0, Math.floor(maxRetries)) + 1 : 1;
    let lastOutcome = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      let retryDueToStatus = false;
      const outcome = await singleAttempt(
        url,
        fetchOptions,
        signal,
        timeoutMs,
        consume
          ? (response) => {
            if (RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
              retryDueToStatus = true;
              return null;
            }
            return consume(response);
          }
          : null
      );

      if (outcome.response) {
        const willRetry = retryDueToStatus
          || (!consume && RETRYABLE_STATUSES.has(outcome.response.status) && attempt < maxAttempts - 1);
        if (willRetry) {
          lastOutcome = outcome;
          const retryAfterMs = parseRetryAfterMs(outcome.response, maxRetryAfterMs);
          const delay = retryAfterMs !== null ? retryAfterMs : backoffDelayMs(attempt, backoffMs);
          await waitInterruptible(delay, signal);
          continue;
        }
        return consume ? outcome.value : outcome.response;
      }

      if (outcome.timeout) throw createTimeoutError(timeoutMs);
      if (outcome.aborted) throw createAbortError();

      if (attempt < maxAttempts - 1) {
        lastOutcome = outcome;
        await waitInterruptible(backoffDelayMs(attempt, backoffMs), signal);
        continue;
      }
      throw outcome.error;
    }

    // Unreachable in practice: every loop iteration returns or throws.
    if (lastOutcome?.response) return consume ? lastOutcome.value : lastOutcome.response;
    throw lastOutcome?.error || createAbortError();
  };

  return semaphore ? semaphore.run(execute) : execute();
}
