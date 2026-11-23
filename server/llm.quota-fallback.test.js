import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaExhaustedError, isRetryable, openAiRoute, openAiPaused, noteOpenAiQuotaExhausted, noteOpenAiHealthy, fallbackAvailable, llmFallbackState, _resetQuotaBreakerForTest } from './llm.js';

// Hermetic: llm.js pulls in db.js, which loads the developer's .env. A developer who has paused OpenAI there (LLM_OPENAI_PAUSED=true)
// would otherwise see every test that expects the OpenAI route fail. CI has no .env, so this changes nothing there.
delete process.env.LLM_OPENAI_PAUSED;

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

import { fallbackMaxTokens } from './llm.js';
describe('fallbackMaxTokens', () => {
  test('quadruples the OpenAI-sized budget for Claude, with a sane floor and ceiling', () => {
    assert.equal(fallbackMaxTokens(1500), 6000);
    assert.equal(fallbackMaxTokens(2500), 10000);
    assert.equal(fallbackMaxTokens(undefined), 2000);
    assert.equal(fallbackMaxTokens(20000), 16000);
  });
});

import { runAnthropic, llmUsageTotals, llmCostUsd, _resetLlmUsageForTest, FALLBACK_HARD_CAP } from './llm.js';
const fakeClient = (replies) => { const calls = []; return { calls, messages: { create: async (req) => { calls.push(req); return replies[calls.length - 1]; } } }; };
const reply = (text, out, stop = 'end_turn', inp = 100) => ({ content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: inp, output_tokens: out } });

describe('Claude fallback ceiling', () => {
  beforeEach(() => _resetLlmUsageForTest());

  test('Chayce-style blog outline (2500 budget) gets a 10000 ceiling and completes', async () => {
    const c = fakeClient([reply('{"outline":"..."}', 7200)]);
    const out = await runAnthropic('s', [{ role: 'user', content: 'u' }], { model: 'claude-haiku-4-5', maxTokens: fallbackMaxTokens(2500), fallback: true, client: c });
    assert.equal(out, '{"outline":"..."}');
    assert.equal(c.calls[0].max_tokens, 10000);
    assert.equal(c.calls.length, 1);
  });

  test('a short task records only what it used, not the ceiling', async () => {
    const c = fakeClient([reply('ok', 12)]);
    await runAnthropic('s', [{ role: 'user', content: 'u' }], { model: 'claude-haiku-4-5', maxTokens: fallbackMaxTokens(500), fallback: true, client: c });
    const [t] = llmUsageTotals();
    assert.equal(t.outputTokens, 12);
    assert.equal(c.calls.length, 1);
  });

  test('a normal (non-fallback) Anthropic call keeps the caller budget and never continues', async () => {
    const c = fakeClient([reply('partial', 500, 'max_tokens')]);
    await runAnthropic('s', [{ role: 'user', content: 'u' }], { model: 'claude-haiku-4-5', maxTokens: 500, fallback: false, client: c });
    assert.equal(c.calls[0].max_tokens, 500);
    assert.equal(c.calls.length, 1);
  });

  test('a fallback reply cut off at the ceiling is continued once, within the hard cap', async () => {
    const c = fakeClient([reply('AAA', 10000, 'max_tokens'), reply('BBB', 900)]);
    const out = await runAnthropic('s', [{ role: 'user', content: 'u' }], { model: 'claude-haiku-4-5', maxTokens: 10000, fallback: true, client: c });
    assert.equal(out, 'AAABBB');
    assert.equal(c.calls.length, 2);
    assert.equal(c.calls[1].max_tokens, FALLBACK_HARD_CAP - 10000);
    assert.equal(c.calls[1].messages.at(-2).content, 'AAA');
    assert.equal(llmUsageTotals()[0].continuations, 1);
  });

  test('at the hard cap there is no room, so no continuation (no unbounded generation)', async () => {
    const c = fakeClient([reply('AAA', 16000, 'max_tokens')]);
    const out = await runAnthropic('s', [{ role: 'user', content: 'u' }], { model: 'claude-haiku-4-5', maxTokens: 16000, fallback: true, client: c });
    assert.equal(out, 'AAA');
    assert.equal(c.calls.length, 1);
  });

  test('it never continues more than once', async () => {
    const c = fakeClient([reply('A', 5000, 'max_tokens'), reply('B', 6000, 'max_tokens'), reply('C', 1)]);
    await runAnthropic('s', [{ role: 'user', content: 'u' }], { model: 'claude-haiku-4-5', maxTokens: 5000, fallback: true, client: c });
    assert.equal(c.calls.length, 2);
  });
});

describe('usage and cost recording', () => {
  beforeEach(() => _resetLlmUsageForTest());
  test('records actual input/output tokens and cost per model', async () => {
    const c = fakeClient([reply('x', 2000, 'end_turn', 1000)]);
    await runAnthropic('s', [{ role: 'user', content: 'u' }], { model: 'claude-haiku-4-5', maxTokens: 4000, fallback: true, client: c });
    const [t] = llmUsageTotals();
    assert.deepEqual([t.inputTokens, t.outputTokens, t.fallback, t.model], [1000, 2000, true, 'claude-haiku-4-5']);
    assert.ok(Math.abs(t.costUsd - (1000 * 1 + 2000 * 5) / 1e6) < 1e-9);
  });
  test('an unknown model records tokens but no invented cost', () => {
    assert.equal(llmCostUsd('some-new-model', 100, 100, {}), null);
  });
  test('prices can be overridden by env', () => {
    assert.equal(llmCostUsd('claude-haiku-4-5', 1e6, 0, { LLM_PRICE_CLAUDE_HAIKU_4_5_IN: '2' }), 2);
  });
});

describe('LLM_OPENAI_PAUSED — Claude straight away while OpenAI is blocked', () => {
  beforeEach(() => _resetQuotaBreakerForTest());
  const paused = { ANTHROPIC_API_KEY: 'sk-ant-test', LLM_OPENAI_PAUSED: 'true' };

  test('every call goes to Claude, and OpenAI is never probed, however long it has been', () => {
    const t0 = 1_000_000;
    assert.equal(openAiRoute(t0, paused), 'fallback');
    assert.equal(openAiRoute(t0 + 16 * 60_000, paused), 'fallback');
    assert.equal(openAiRoute(t0 + 24 * 60 * 60_000, paused), 'fallback');
  });
  test('it needs an Anthropic key: without one it does nothing, so calls are never sent to a provider with no key', () => {
    assert.equal(openAiPaused({ LLM_OPENAI_PAUSED: 'true' }), false);
    assert.equal(openAiRoute(1, { LLM_OPENAI_PAUSED: 'true' }), 'openai');
  });
  test('only an explicit yes turns it on; unset, empty or "false" leave OpenAI in use', () => {
    for (const v of [undefined, '', 'false', '0', 'off']) assert.equal(openAiPaused({ ANTHROPIC_API_KEY: 'k', LLM_OPENAI_PAUSED: v }), false, String(v));
    for (const v of ['true', '1', 'on', 'yes', 'TRUE']) assert.equal(openAiPaused({ ANTHROPIC_API_KEY: 'k', LLM_OPENAI_PAUSED: v }), true, v);
  });
  test('llmFallbackState reports it as active', () => {
    const prev = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'k'; process.env.LLM_OPENAI_PAUSED = 'true';
    try { assert.deepEqual({ active: llmFallbackState().active, paused: llmFallbackState().paused }, { active: true, paused: true }); }
    finally { process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY; process.env.LLM_OPENAI_PAUSED = prev.LLM_OPENAI_PAUSED; if (prev.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY; if (prev.LLM_OPENAI_PAUSED === undefined) delete process.env.LLM_OPENAI_PAUSED; }
  });
});
