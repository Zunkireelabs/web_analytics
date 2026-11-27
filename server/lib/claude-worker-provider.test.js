import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const { workerMode, workerFallback, routeCall, callViaWorker, workerUnavailable } = await import('./claude-worker-provider.js');
const { isProviderFault, llmFailure } = await import('../generators/lib/llm-error.js');
const { classifyAbandonReason, RETRY_POLICY } = await import('./attempt-classification.js');

const on = { LLM_WORKER_MODE: 'on' };

describe('where an AI call goes', () => {
  test('off by default: every call uses the API, exactly as before, so deploying this changes nothing', async () => {
    assert.equal(workerMode({}), false);
    assert.equal(await routeCall({ generatorId: 'meta-title' }, { env: {}, online: async () => { throw new Error('must not be asked'); } }), 'api');
  });
  test('on: a call that names a generator goes to the worker when one is connected', async () => {
    assert.equal(await routeCall({ generatorId: 'expand-content' }, { env: on, online: async () => true }), 'worker');
  });
  test('on: analysis and narration (no generator) go to the worker when one is connected, and are refused (retried later) when none is, unless LLM_WORKER_FALLBACK=api', async () => {
    assert.equal(await routeCall({}, { env: on, online: async () => true }), 'worker');
    assert.equal(await routeCall({ generatorId: null }, { env: on, online: async () => true }), 'worker');
    await assert.rejects(() => routeCall({}, { env: on, online: async () => false }), (e) => e.workerOffline === true && e.llmProvider === true);
    assert.equal(await routeCall({}, { env: { ...on, LLM_WORKER_FALLBACK: 'api' }, online: async () => false }), 'api');
  });
  test('off: a call without a generator never asks whether a worker is online', async () => {
    assert.equal(await routeCall({}, { env: {}, online: async () => { throw new Error('must not be asked'); } }), 'api');
  });
  test('on with no worker connected: the call fails as an outage by default, never silently going to the paid API', async () => {
    await assert.rejects(() => routeCall({ generatorId: 'faq' }, { env: on, online: async () => false }), (e) => e.workerOffline === true && e.llmProvider === true && e.status === 502);
  });
  test('on with no worker and LLM_WORKER_FALLBACK=api: the API is used as before', async () => {
    assert.equal(workerFallback({ LLM_WORKER_FALLBACK: 'api' }), 'api');
    assert.equal(await routeCall({ generatorId: 'faq' }, { env: { ...on, LLM_WORKER_FALLBACK: 'api' }, online: async () => false }), 'api');
  });
});

describe('a call through the queue', () => {
  test('the prompt goes in, the worker\'s text comes back', async () => {
    let queued;
    const text = await callViaWorker({ system: 'S', user: 'U', generatorId: 'meta-title', siteId: 8862, maxTokens: 400, pageUrl: 'https://x/' }, {
      env: on, enqueue: async (r) => { queued = r; return 42; }, wait: async (id) => (id === 42 ? { ok: true, text: '{"titles":["A"]}' } : { ok: false }),
    });
    assert.equal(text, '{"titles":["A"]}');
    assert.deepEqual([queued.system, queued.user, queued.generatorId, queued.siteId], ['S', 'U', 'meta-title', 8862]);
    assert.equal(queued.options.maxTokens, 400);
  });
  test('a call a person is waiting on can ask for a shorter wait than the 10-minute default', async () => {
    let waited; let queued;
    await callViaWorker({ system: 'S', user: 'U', generatorId: 'draft-edit', waitMs: 100000 }, { env: on, enqueue: async (r) => { queued = r; return 1; }, wait: async (id, o) => { waited = o.timeoutMs; return { ok: true, text: 'x' }; } });
    assert.equal(waited, 100000);
    assert.equal(queued.ttlMs, 100000);
    await callViaWorker({ system: 'S', user: 'U', generatorId: 'faq' }, { env: on, enqueue: async (r) => { queued = r; return 2; }, wait: async (id, o) => { waited = o.timeoutMs; return { ok: true, text: 'x' }; } });
    assert.equal(waited, 600000, 'every other call keeps the long default');
  });
  test('no answer in time is an outage that names the cause, never a generator defect', async () => {
    const err = await callViaWorker({ system: 'S', user: 'U', generatorId: 'faq' }, { env: on, enqueue: async () => 7, wait: async () => ({ ok: false, reason: 'expired', error: 'x' }) }).catch((e) => e);
    assert.equal(err.workerReason, 'expired');
    assert.match(err.message, /laptop may have closed/);
    assert.equal(isProviderFault(err), true, 'counted as the AI provider being unavailable (degrades the re-check, so nothing is closed)');
  });
  test('a failure the worker reports is also an outage, and the generators\' own wrapper keeps it that way', async () => {
    const err = await callViaWorker({ system: 'S', user: 'U', generatorId: 'faq' }, { env: on, enqueue: async () => 7, wait: async () => ({ ok: false, reason: 'failed', error: 'claude exited 1' }) }).catch((e) => e);
    const wrapped = llmFailure(err, 'FAQ generation failed: model did not return valid JSON');
    assert.equal(wrapped.llmProvider, true);
    assert.match(wrapped.message, /^LLM provider error:/);
    assert.equal(classifyAbandonReason(wrapped.message).retryPolicy, RETRY_POLICY.RETRY, 'retried later, never scored against the generator');
  });
  test('the wait is bounded: LLM_WORKER_WAIT_MS, never less than 30 seconds', async () => {
    let waited;
    await callViaWorker({ system: 'S', user: 'U', generatorId: 'x' }, { env: { ...on, LLM_WORKER_WAIT_MS: '1000' }, enqueue: async (r) => { waited = r.ttlMs; return 1; }, wait: async (_id, o) => { assert.equal(o.timeoutMs, 30_000); return { ok: true, text: '' }; } });
    assert.equal(waited, 30_000);
  });
  test('workerUnavailable carries what the platform reads as a provider fault', () => assert.equal(isProviderFault(workerUnavailable('x')), true));
});
