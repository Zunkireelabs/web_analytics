import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Proves the promoted model actually reaches the provider call, and only where it should: decision-engine calls, same provider,
// no explicitly forced model. Everything else keeps its configured model.
const sent = [];
class FakeAnthropic { constructor() { this.messages = { create: async (req) => { sent.push(req.model); return { content: [{ type: 'text', text: 'ok' }] }; } }; } }
let active = null;
mock.module('@anthropic-ai/sdk', { defaultExport: FakeAnthropic });
mock.module('openai', { defaultExport: class FakeOpenAI {} });
mock.module('./lib/model-override.js', { namedExports: { activeModelFor: async (role) => (role === 'decision' ? active : null), clearModelOverrideCache() {} } });
mock.module('./agent-memory.js', { namedExports: { withAgentMemory: async (s) => s } });
mock.module('./implementers/lib/design-drift.js', { namedExports: { withDesignContext: async (s) => s } });
mock.module('./agents/lib/competitor-policy.js', { namedExports: { withCompetitorContext: async (s) => s } });
process.env.REPORT_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.REPORT_MODEL_MONTHLY;
const { callLLM, MODEL_DEFAULTS } = await import('./llm.js');

beforeEach(() => { sent.length = 0; active = null; });

test('a promoted decision model serves decision calls', async () => {
  active = { provider: 'anthropic', model: 'ft-decision-v1' };
  await callLLM('s', 'u', { tier: 'monthly', modelRole: 'decision' });
  assert.deepEqual(sent, ['ft-decision-v1']);
});
test('no promoted model: the configured default is used, unchanged', async () => {
  await callLLM('s', 'u', { tier: 'monthly', modelRole: 'decision' });
  assert.deepEqual(sent, [MODEL_DEFAULTS.anthropic.monthly]);
});
test('a call without the decision role never gets the decision model', async () => {
  active = { provider: 'anthropic', model: 'ft-decision-v1' };
  await callLLM('s', 'u', { tier: 'monthly' });
  assert.deepEqual(sent, [MODEL_DEFAULTS.anthropic.monthly]);
});
test('a model from another provider is ignored', async () => {
  active = { provider: 'openai', model: 'ft-other' };
  await callLLM('s', 'u', { tier: 'monthly', modelRole: 'decision' });
  assert.deepEqual(sent, [MODEL_DEFAULTS.anthropic.monthly]);
});
test('an explicitly forced model always wins', async () => {
  active = { provider: 'anthropic', model: 'ft-decision-v1' };
  await callLLM('s', 'u', { model: 'forced', modelRole: 'decision' });
  assert.deepEqual(sent, ['forced']);
});
