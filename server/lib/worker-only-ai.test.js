import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidApiAllowed, paidApiRefused } from './worker-only-ai.js';
import { makeAgenticClient } from '../agents/lib/agentic-client.js';

test('paid API: allowed with the mode off or LLM_WORKER_FALLBACK=api, refused with the worker on', () => {
  assert.equal(paidApiAllowed({}), true);
  assert.equal(paidApiAllowed({ LLM_WORKER_MODE: 'on' }), false);
  assert.equal(paidApiAllowed({ LLM_WORKER_MODE: 'on', LLM_WORKER_FALLBACK: 'api' }), true);
});
test('the refusal reads as a provider outage (retried later), not a failure of the work', () => {
  const e = paidApiRefused('X');
  assert.ok(e.status === 502 && e.llmProvider === true && e.workerUnavailable === true);
});
test('the agentic client with real keys refuses while the worker is on', async () => {
  const client = makeAgenticClient({ env: { LLM_WORKER_MODE: 'on', OPENAI_API_KEY: 'sk-real', ANTHROPIC_API_KEY: 'sk-ant' } });
  await assert.rejects(() => client.chat.completions.create({ messages: [{ role: 'user', content: 'hi' }] }), (e) => e.workerUnavailable === true);
});
