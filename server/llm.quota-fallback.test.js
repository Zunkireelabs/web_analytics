import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaExhaustedError, isRetryable, openAiRoute, noteOpenAiQuotaExhausted, noteOpenAiHealthy, fallbackAvailable, llmFallbackState, _resetQuotaBreakerForTest } from './llm.js';

// The real error OpenAI returned on 2026-11-20 for an exhausted project.
const spendLimit429 = Object.assign(new Error('429 Your project has reached its configured enforced spend limit. Update your limit at https://platform.openai.com/settings/proj_x/limits.'), { status: 429, code: 'project_spend_limit_exceeded', type: 'insufficient_quota' });
const rateLimit429 = Object.assign(new Error('429 Rate limit reached for gpt-4o-mini in organization on requests per min'), { status: 429, code: 'rate_limit_exceeded' });
const withKey = { ANTHROPIC_API_KEY: 'sk-ant-test' };

describe('isQuotaExhaustedError', () => {
  test('recognises the OpenAI spend-limit 429', () => assert.equal(isQuotaExhaustedError(spendLimit429), true));
  test('recognises an exhausted-credit quota error', () => {
    assert.equal(isQuotaExhaustedError(Object.assign(new Error('You exceeded your current quota, please check your plan and billing details.'), { status: 429, code: 'insufficient_quota' })), true);
  });
  test('an ordinary rate limit is NOT a quota error', () => assert.equal(isQuotaExhaustedError(rateLimit429), false));
  test('a 500 or a network error is NOT a quota error', () => {
    assert.equal(isQuotaExhaustedError(Object.assign(new Error('boom'), { status: 500 })), false);
    assert.equal(isQuotaExhaustedError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), false);
    assert.equal(isQuotaExhaustedError(null), false);
  });
  test('a non-429 error whose text mentions billing is NOT treated as quota', () => {
    assert.equal(isQuotaExhaustedError(Object.assign(new Error('billing address invalid'), { status: 400 })), false);
  });
});

describe('isRetryable', () => {
  test('a quota 429 is not retried, an ordinary rate limit still is', () => {
    assert.equal(isRetryable(spendLimit429), false);
    assert.equal(isRetryable(rateLimit429), true);
    assert.equal(isRetryable(Object.assign(new Error('x'), { status: 503 })), true);
  });
});

describe('OpenAI quota breaker', () => {
  beforeEach(() => _resetQuotaBreakerForTest());
  const t0 = 1_000_000;

  test('stays on OpenAI until a quota error is seen', () => {
    assert.equal(openAiRoute(t0, withKey), 'openai');
  });
  test('without an Anthropic key it never leaves OpenAI, even after a quota error', () => {
    assert.equal(fallbackAvailable({}), false);
    noteOpenAiQuotaExhausted(spendLimit429, t0);
    assert.equal(openAiRoute(t0 + 1, {}), 'openai');
  });
  test('LLM_FALLBACK_ON_QUOTA=off disables the fallback', () => {
    assert.equal(fallbackAvailable({ ...withKey, LLM_FALLBACK_ON_QUOTA: 'off' }), false);
  });
  test('after a quota error calls go to the fallback for the cooldown', () => {
    noteOpenAiQuotaExhausted(spendLimit429, t0);
    assert.equal(llmFallbackState().active, true);
    assert.equal(openAiRoute(t0 + 60_000, withKey), 'fallback');
    assert.equal(openAiRoute(t0 + 14 * 60_000, withKey), 'fallback');
  });
  test('when the cooldown ends exactly one call probes OpenAI, the rest keep using the fallback', () => {
    noteOpenAiQuotaExhausted(spendLimit429, t0);
    const after = t0 + 16 * 60_000;
    assert.equal(openAiRoute(after, withKey), 'probe');
    assert.equal(openAiRoute(after + 1, withKey), 'fallback');
    assert.equal(openAiRoute(after + 30_000, withKey), 'fallback');
  });
  test('a successful probe switches everything back to OpenAI automatically', () => {
    noteOpenAiQuotaExhausted(spendLimit429, t0);
    assert.equal(openAiRoute(t0 + 16 * 60_000, withKey), 'probe');
    noteOpenAiHealthy();
    assert.equal(llmFallbackState().active, false);
    assert.equal(openAiRoute(t0 + 16 * 60_000 + 5, withKey), 'openai');
  });
  test('a failed probe restarts the cooldown', () => {
    noteOpenAiQuotaExhausted(spendLimit429, t0);
    const probeAt = t0 + 16 * 60_000;
    assert.equal(openAiRoute(probeAt, withKey), 'probe');
    noteOpenAiQuotaExhausted(spendLimit429, probeAt);
    assert.equal(openAiRoute(probeAt + 60_000, withKey), 'fallback');
    assert.equal(openAiRoute(probeAt + 16 * 60_000, withKey), 'probe');
  });
});
