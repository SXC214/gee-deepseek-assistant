import assert from "node:assert/strict";
import { createSemaphore, fetchWithPolicy, waitInterruptible } from "../lib/http.js";

function mockResponse(status, { headers = {}, text = "" } = {}) {
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lowered[String(name).toLowerCase()] ?? null },
    text: async () => text
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Success: fetch options forwarded, response returned untouched.
{
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return mockResponse(200, { text: "ok" });
  };
  const response = await fetchWithPolicy("https://example.com/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(response.status, 200);
  assert.equal(captured.url, "https://example.com/data");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.body, "{}");
  assert.ok(captured.options.signal instanceof AbortSignal, "internal signal attached");
}

// --- Timeout: hangs until internal abort, TimeoutError with Chinese message.
{
  let calls = 0;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    calls += 1;
    options.signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
  const error = await fetchWithPolicy("https://slow.example.com", { timeoutMs: 30, retryable: true })
    .then(() => null, (failure) => failure);
  assert.ok(error, "timeout should reject");
  assert.equal(error.name, "TimeoutError");
  assert.match(error.message, /请求超时/);
  assert.equal(calls, 1, "timeout is never retried");
}

// --- Retry: 503 then success, exactly two attempts.
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? mockResponse(503) : mockResponse(200);
  };
  const response = await fetchWithPolicy("https://flaky.example.com", {
    retryable: true,
    maxRetries: 3,
    backoffMs: 2
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
}

// --- Retry exhaustion: returns the final failing response for caller handling.
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return mockResponse(502);
  };
  const response = await fetchWithPolicy("https://down.example.com", {
    retryable: true,
    maxRetries: 2,
    backoffMs: 2
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 3, "initial attempt plus two retries");
}

// --- No retry without explicit opt-in, and only for 429/502/503/504.
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return mockResponse(503);
  };
  await fetchWithPolicy("https://a.example.com", { backoffMs: 2 });
  assert.equal(calls, 1, "retryable must be explicit");

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return mockResponse(500);
  };
  const response = await fetchWithPolicy("https://b.example.com", { retryable: true, backoffMs: 2 });
  assert.equal(response.status, 500);
  assert.equal(calls, 1, "500 is not a retryable status");
}

// --- Retry-After (seconds) is honored on 429.
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? mockResponse(429, { headers: { "Retry-After": "1" } })
      : mockResponse(200);
  };
  const started = Date.now();
  const response = await fetchWithPolicy("https://limited.example.com", {
    retryable: true,
    maxRetries: 1,
    backoffMs: 2
  });
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.ok(elapsed >= 900, `waited for Retry-After, elapsed=${elapsed}`);
  assert.ok(elapsed < 3000, "did not wait beyond the header");
}

// --- Network errors are retried.
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("Failed to fetch");
    return mockResponse(200);
  };
  const response = await fetchWithPolicy("https://network.example.com", {
    retryable: true,
    maxRetries: 3,
    backoffMs: 2
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
}

// --- External abort: never retried, immediate AbortError.
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return mockResponse(503);
  };
  const preAborted = new AbortController();
  preAborted.abort();
  const preError = await fetchWithPolicy("https://x.example.com", {
    retryable: true,
    signal: preAborted.signal
  }).then(() => null, (failure) => failure);
  assert.equal(preError?.name, "AbortError");
  assert.equal(calls, 0, "pre-aborted signal skips the request entirely");

  calls = 0;
  const controller = new AbortController();
  globalThis.fetch = async () => {
    calls += 1;
    return mockResponse(503);
  };
  const started = Date.now();
  const pending = fetchWithPolicy("https://x.example.com", {
    retryable: true,
    maxRetries: 3,
    backoffMs: 300,
    signal: controller.signal
  });
  // First attempt fails with 503; abort while the retry backoff is waiting.
  setTimeout(() => controller.abort(), 20);
  const error = await pending.then(() => null, (failure) => failure);
  assert.equal(error?.name, "AbortError");
  assert.equal(calls, 1, "abort during backoff prevents further attempts");
  assert.ok(Date.now() - started < 400, "abort interrupts the backoff wait");
}

// --- waitInterruptible resolves and rejects on abort.
{
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 10);
  const error = await waitInterruptible(5000, controller.signal)
    .then(() => null, (failure) => failure);
  assert.equal(error?.name, "AbortError");
  assert.ok(Date.now() - started < 1000, "abort interrupts the wait immediately");

  const quick = Date.now();
  await waitInterruptible(5);
  assert.ok(Date.now() - quick < 1000);
}

// --- Semaphore: limits concurrency, FIFO-ish completion, idempotent release.
{
  const gate = createSemaphore(2);
  let inFlight = 0;
  let peak = 0;
  const finished = [];
  await Promise.all(Array.from({ length: 5 }, (_unused, index) => gate.run(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(10);
    inFlight -= 1;
    finished.push(index);
  })));
  assert.equal(peak, 2, "no more than the limit runs at once");
  assert.equal(finished.length, 5);
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);

  const release = await gate.acquire();
  release();
  release();
  assert.equal(gate.active, 0, "release is idempotent");
  assert.throws(() => createSemaphore(0), /正整数/);
}

// --- fetchWithPolicy holds the semaphore for the whole request.
{
  const gate = createSemaphore(2);
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(10);
    inFlight -= 1;
    return mockResponse(200);
  };
  const results = await Promise.all(Array.from({ length: 6 }, () => fetchWithPolicy("https://s.example.com", {
    semaphore: gate
  })));
  assert.equal(results.length, 6);
  assert.ok(results.every((response) => response.status === 200));
  assert.equal(peak, 2, "semaphore caps in-flight fetches");
  assert.equal(gate.active, 0);
}

console.log("Http kernel tests passed.");
