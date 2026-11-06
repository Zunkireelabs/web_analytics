import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataforseoCall } from './client.js';

const env = { DATAFORSEO_LOGIN: 'user', DATAFORSEO_PASSWORD: 'pass' };

function harness({ budget = null, spent = 0, response }) {
  const rows = [];
  let calls = 0;
  return {
    rows,
    calls: () => calls,
    args: {
      siteId: 7, job: 'test-job', endpoint: '/v3/test/live', body: [{ a: 1 }], env,
      fetchImpl: async () => { calls++; return response; },
      deps: {
        recordSpend: async (siteId, row) => { rows.push({ siteId, ...row }); },
        getMonthSpendUsd: async () => spent,
        getMonthlyBudgetUsd: async () => budget,
      },
    },
  };
}
const okResponse = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });

test('a successful call records the cost DataForSEO reported', async () => {
  const h = harness({ response: okResponse({ cost: 0.012, tasks: [{ status_code: 20000 }] }) });
  const out = await dataforseoCall(h.args);
  assert.equal(out.ok, true);
  assert.equal(out.costUsd, 0.012);
  assert.deepEqual(h.rows.map((r) => [r.siteId, r.status, r.costUsd]), [[7, 'ok', 0.012]]);
});

test('a response without a cost is stored as NULL, not zero', async () => {
  const h = harness({ response: okResponse({ tasks: [{ status_code: 20000 }] }) });
  await dataforseoCall(h.args);
  assert.equal(h.rows[0].costUsd, null);
});

test('over the monthly budget: no call is made and the refusal is recorded', async () => {
  const h = harness({ budget: 1, spent: 1.2, response: okResponse({}) });
  const out = await dataforseoCall(h.args);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'budget_refused');
  assert.equal(h.calls(), 0);
  assert.equal(h.rows[0].status, 'budget_refused');
});

test('under budget and no cap both allow the call', async () => {
  for (const budget of [null, 5]) {
    const h = harness({ budget, spent: 1, response: okResponse({ cost: 0.01, tasks: [{ status_code: 20000 }] }) });
    assert.equal((await dataforseoCall(h.args)).ok, true);
  }
});

test('a task error that was still billed is recorded as charged_failed with its cost', async () => {
  const h = harness({ response: okResponse({ cost: 0.05, tasks: [{ status_code: 50000, status_message: 'Internal Error' }] }) });
  const out = await dataforseoCall(h.args);
  assert.equal(out.ok, false);
  assert.equal(out.costUsd, 0.05);
  assert.equal(h.rows[0].status, 'charged_failed');
});

test('an HTTP failure with no cost is plain failed', async () => {
  const h = harness({ response: okResponse({}, 500) });
  const out = await dataforseoCall(h.args);
  assert.equal(out.reason, 'failed');
  assert.equal(h.rows[0].status, 'failed');
});

test('a network error is recorded and returned, not thrown', async () => {
  const h = harness({ response: null });
  h.args.fetchImpl = async () => { throw new Error('socket hang up'); };
  const out = await dataforseoCall(h.args);
  assert.equal(out.ok, false);
  assert.match(out.error, /socket hang up/);
  assert.equal(h.rows[0].status, 'failed');
});

test('no siteId or no credentials is a programming/config error and throws', async () => {
  const h = harness({ response: okResponse({}) });
  await assert.rejects(() => dataforseoCall({ ...h.args, siteId: null }), /siteId/);
  await assert.rejects(() => dataforseoCall({ ...h.args, env: {} }), /not set/);
});

test('the credentials never appear in what is recorded', async () => {
  const h = harness({ response: okResponse({ cost: 0.01, tasks: [{ status_code: 20000 }] }) });
  await dataforseoCall(h.args);
  assert.ok(!JSON.stringify(h.rows).includes('pass'));
});
