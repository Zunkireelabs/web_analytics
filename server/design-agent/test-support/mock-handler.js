// TEST-ONLY. Simulates a Design Agent job handler (the real OpenHands
// integration lands in Step 6C) so worker.test.js can exercise claim
// concurrency, in-flight-job shutdown, and completed/failed transitions
// without any real generation work. Never imported by production code
// (server/design-agent/worker.js's default handler is notImplementedHandler,
// defined locally there) — only by tests, via createWorker's `handler`
// option.
export function createMockHandler({ delayMs = 0, shouldFail = false, onRun } = {}) {
  return async function mockHandler(job) {
    if (onRun) onRun(job);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (shouldFail) throw new Error('mock handler configured to fail');
    return { ok: true };
  };
}
