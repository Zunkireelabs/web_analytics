// PROVIDER HEALTH, as seen by whoever is waiting on a result.
//
// An agent that asks the model for part of its findings and gets a provider failure (out of credit, bad key, outage) used to
// catch it, log one line and return a normal-looking result with those findings simply missing. The nightly re-check then read
// "no finding" as "fixed" and closed the issue; the next daily run found it again and created it as new. That is the daily churn.
//
// This counter only ever goes up. A caller reads it before and after a piece of work: if it moved, a model call failed because the
// provider was unavailable during that work, so "I did not see the issue" is not evidence that it is gone. Concurrent work can move
// it too, which errs in the safe direction (an issue stays open one more night).
//
// No imports on purpose: runner.js, the re-check and llm.js all use it, and none of them may pull the AI SDKs in just to read a number.
const state = { failures: 0, lastAt: null, lastMessage: null };

export function providerFailureCount() { return state.failures; }
export function lastProviderFailure() { return { ...state }; }
export function noteProviderFailure(err) {
  state.failures += 1;
  state.lastAt = new Date().toISOString();
  state.lastMessage = String(err?.message || err?.code || 'provider call failed').slice(0, 200);
}
export function _resetProviderHealthForTest() { state.failures = 0; state.lastAt = null; state.lastMessage = null; }
