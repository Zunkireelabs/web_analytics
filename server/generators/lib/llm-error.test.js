import test from 'node:test';
import assert from 'node:assert/strict';
import { llmFailure } from './llm-error.js';
import { classifyShipFailure, FAILURE_KIND } from '../../agents/lib/failure-policy.js';
import { classifyAbandonReason, RETRY_POLICY } from '../../lib/attempt-classification.js';

const MSG = 'FAQ generation failed: model did not return valid JSON';

test('OpenAI 429 no-credits keeps its text, is tagged quota, and is not a 429/userFacing', () => {
  const src = Object.assign(new Error('429 You have no credits remaining. Add credits to continue.'), { status: 429 });
  const e = llmFailure(src, MSG, { status: 400 });
  assert.match(e.message, /no credits remaining/);
  assert.equal(e.llmQuota, true);
  assert.equal(e.status, 502);
  assert.equal(e.llmStatus, 429);
  assert.notEqual(e.userFacing, true);
});

test('bad key is tagged auth', () => {
  const e = llmFailure(Object.assign(new Error('401 Incorrect API key provided'), { status: 401 }), MSG);
  assert.equal(e.llmAuth, true);
});

test('callLLMForJson own invalid-JSON failure keeps the old message and shape', () => {
  const src = Object.assign(new Error('Model did not return valid JSON after 2 attempts.'), { status: 400 });
  const e = llmFailure(src, MSG, { status: 400, userFacing: true });
  assert.equal(e.message, MSG);
  assert.equal(e.status, 400);
  assert.equal(e.userFacing, true);
  assert.equal(e.llmProvider, undefined);
});

test("a generator's own plain 'not an array' error stays an output fault", () => {
  const e = llmFailure(new Error('not an array'), MSG);
  assert.equal(e.message, MSG);
  assert.equal(e.llmProvider, undefined);
});

test('network error is a provider fault but not quota', () => {
  const e = llmFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), MSG);
  assert.equal(e.llmProvider, true);
  assert.equal(e.llmQuota, undefined);
});

test('failure policy stops the run for quota and auth, not for a one-off provider error', () => {
  const quota = llmFailure(Object.assign(new Error('429 You have no credits remaining'), { status: 429 }), MSG);
  assert.equal(classifyShipFailure(quota).kind, FAILURE_KIND.SYSTEMIC);
  const auth = llmFailure(Object.assign(new Error('Incorrect API key'), { status: 401 }), MSG);
  assert.equal(classifyShipFailure(auth).kind, FAILURE_KIND.SYSTEMIC);
  assert.equal(classifyShipFailure(new Error('429 You have no credits remaining')).kind, FAILURE_KIND.SYSTEMIC);
});

test('a provider error is not scored against the generator', () => {
  const r = classifyAbandonReason('LLM provider error: 429 You have no credits remaining');
  assert.equal(r.retryPolicy, RETRY_POLICY.RETRY);
});

test('the OpenAI project spend-limit 429 (real text from prod, 2026-11-19) is a quota failure, kept with its real message', () => {
  const src = Object.assign(new Error('429 Your project has reached its configured enforced spend limit. Update your limit at https://platform.openai.com/settings/proj_x/limits.'), { status: 429 });
  const e = llmFailure(src, 'fallback text');
  assert.match(e.message, /enforced spend limit/);
  assert.equal(e.llmQuota, true);
  assert.equal(classifyShipFailure(new Error(src.message)).kind, FAILURE_KIND.SYSTEMIC);
});
