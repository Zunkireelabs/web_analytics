import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// The OpenAI SDK does not use globalThis.fetch, so it is replaced with a recorder that returns the SDK's real response shape.
// Anthropic stays the real SDK, stubbed at fetch.
const openaiCalls = [];
mock.module('openai', { defaultExport: class RecordingOpenAI {
  constructor() {
    this.chat = { completions: { create: async (req) => {
      openaiCalls.push(req.model);
      return { id: 'c', object: 'chat.completion', created: 0, model: req.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'from openai' } }] };
    } } };
  }
} });
const { resolveProviderAndModel, callLLM } = await import('./llm.js');

// Hermetic: the import above loads db.js, which loads the developer's .env. A developer who has paused OpenAI there
// (LLM_OPENAI_PAUSED=true) would otherwise see every test that expects the OpenAI route fail. CI has no .env, so nothing changes there.
delete process.env.LLM_OPENAI_PAUSED;

// Live today: REPORT_PROVIDER=openai with REPORT_MODEL_DAILY=gpt-4o-mini / MONTHLY=gpt-4o, both keys set.
const LIVE = {
  REPORT_PROVIDER: 'openai', REPORT_MODEL_DAILY: 'gpt-4o-mini', REPORT_MODEL_MONTHLY: 'gpt-4o',
  OPENAI_API_KEY: 'sk-proj-real', ANTHROPIC_API_KEY: 'sk-ant-real',
};

describe('resolveProviderAndModel', () => {
  test('nothing new set: every task behaves exactly as before', () => {
    for (const task of [undefined, 'report', 'content']) {
      assert.deepEqual(resolveProviderAndModel({ task, env: LIVE }), { provider: 'openai', model: 'gpt-4o-mini' });
      assert.deepEqual(resolveProviderAndModel({ task, tier: 'monthly', env: LIVE }), { provider: 'openai', model: 'gpt-4o' });
    }
  });

  test('content on Claude: never receives the OpenAI REPORT_MODEL_*; reports and untagged stay on OpenAI', () => {
    const env = { ...LIVE, LLM_PROVIDER_CONTENT: 'anthropic', LLM_PROVIDER_REPORTS: 'openai' };
    assert.deepEqual(resolveProviderAndModel({ task: 'content', env }), { provider: 'anthropic', model: 'claude-haiku-4-5' });
    assert.deepEqual(resolveProviderAndModel({ task: 'content', tier: 'monthly', env }), { provider: 'anthropic', model: 'claude-opus-4-8' });
    assert.deepEqual(resolveProviderAndModel({ task: 'report', env }), { provider: 'openai', model: 'gpt-4o-mini' });
    assert.deepEqual(resolveProviderAndModel({ env }), { provider: 'openai', model: 'gpt-4o-mini' });
  });

  test('per-task model variables win over the defaults', () => {
    const env = { ...LIVE, LLM_PROVIDER_CONTENT: 'anthropic', LLM_MODEL_CONTENT_DAILY: 'claude-haiku-5-5', LLM_MODEL_CONTENT_MONTHLY: 'claude-sonnet-5-5' };
    assert.equal(resolveProviderAndModel({ task: 'content', env }).model, 'claude-haiku-5-5');
    assert.equal(resolveProviderAndModel({ task: 'content', tier: 'monthly', env }).model, 'claude-sonnet-5-5');
  });

  test('a task switched to a provider with no key stays on the working default', () => {
    const env = { ...LIVE, ANTHROPIC_API_KEY: '', LLM_PROVIDER_CONTENT: 'anthropic' };
    assert.deepEqual(resolveProviderAndModel({ task: 'content', env }), { provider: 'openai', model: 'gpt-4o-mini' });
  });

  test('odd tiers (safe, nearby, ...) use the daily model instead of undefined', () => {
    const env = { OPENAI_API_KEY: 'sk-proj-real' };
    assert.equal(resolveProviderAndModel({ tier: 'safe', env }).model, 'gpt-4o-mini');
  });

  test('a forced model and a same-provider promoted model still win', () => {
    assert.equal(resolveProviderAndModel({ task: 'content', model: 'x', env: LIVE }).model, 'x');
    assert.equal(resolveProviderAndModel({ promoted: { provider: 'openai', model: 'ft:y' }, env: LIVE }).model, 'ft:y');
    assert.equal(resolveProviderAndModel({ promoted: { provider: 'anthropic', model: 'z' }, env: LIVE }).model, 'gpt-4o-mini');
  });
});

// Through the real SDKs: the request has to land on the right host with the right model.
describe('callLLM routes each task to its provider', () => {
  test('content → Anthropic, report and untagged → OpenAI', async () => {
    const saved = { ...process.env };
    const originalFetch = globalThis.fetch;
    Object.assign(process.env, LIVE, { LLM_PROVIDER_CONTENT: 'anthropic', LLM_PROVIDER_REPORTS: 'openai', MODEL_REGISTRY: 'false' });
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url?.url || url);
      const body = JSON.parse(init.body);
      seen.push({ host: new URL(u).host, model: body.model });
      const payload = { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'from claude' }], model: body.model, stop_reason: 'end_turn', usage: {} };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      assert.equal(await callLLM('s', 'u', { task: 'content' }), 'from claude');
      assert.equal(await callLLM('s', 'u', { task: 'report' }), 'from openai');
      assert.equal(await callLLM('s', 'u'), 'from openai');
      assert.deepEqual(seen, [{ host: 'api.anthropic.com', model: 'claude-haiku-4-5' }]);
      assert.deepEqual(openaiCalls, ['gpt-4o-mini', 'gpt-4o-mini']);
    } finally {
      globalThis.fetch = originalFetch;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
