import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let issued; let respond;
mock.module(resolve('../db.js'), { namedExports: { query: async (sql, params) => { issued.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return respond(sql, params); } } });
const S = await import('./llm-requests.js');

beforeEach(() => { issued = []; respond = () => ({ rows: [], rowCount: 0 }); });

describe('the caller\'s side', () => {
  test('enqueue stores the prompt and how long it is worth answering, and returns the id', async () => {
    respond = () => ({ rows: [{ id: 17 }] });
    const id = await S.enqueueRequest({ siteId: 8862, generatorId: 'faq', system: 'S', user: 'U', options: { maxTokens: 300 }, ttlMs: 120_000 });
    assert.equal(id, 17);
    assert.deepEqual(issued[0].params, [8862, 'faq', 'S', 'U', '{"maxTokens":300}', 120_000]);
    assert.match(issued[0].sql, /INSERT INTO llm_requests/);
  });
  test('wait returns the text once the request is done', async () => {
    let n = 0;
    respond = () => ({ rows: [n++ < 2 ? { status: 'claimed' } : { status: 'done', response_text: 'hello' }] });
    const r = await S.waitForRequest(1, { timeoutMs: 60_000, pollMs: 1, sleep: async () => {} });
    assert.deepEqual(r, { ok: true, text: 'hello' });
  });
  test('wait reports a failed or expired request with its reason', async () => {
    respond = () => ({ rows: [{ status: 'failed', error: 'claude exited 1' }] });
    assert.deepEqual(await S.waitForRequest(1, { sleep: async () => {} }), { ok: false, reason: 'failed', error: 'claude exited 1' });
    respond = () => ({ rows: [{ status: 'expired' }] });
    assert.equal((await S.waitForRequest(1, { sleep: async () => {} })).reason, 'expired');
    respond = () => ({ rows: [] });
    assert.equal((await S.waitForRequest(1, { sleep: async () => {} })).reason, 'missing');
  });
  test('wait never waits past its deadline: the request is closed so a late worker does not write for nobody', async () => {
    let t = 0;
    respond = (sql) => (/UPDATE/.test(sql) ? { rows: [], rowCount: 1 } : { rows: [{ status: 'pending' }] });
    const r = await S.waitForRequest(5, { timeoutMs: 3000, pollMs: 1000, now: () => t, sleep: async (ms) => { t += ms; } });
    assert.equal(r.reason, 'expired');
    assert.ok(issued.some((q) => /SET status = 'expired' WHERE id = \$1 AND status IN \('pending', 'claimed'\)/.test(q.sql)));
  });
});

describe('the worker\'s side', () => {
  test('claim takes the oldest waiting requests, never the same one twice, at most 5 at a time', async () => {
    respond = () => ({ rows: [{ id: 3, site_id: 8862, generator_id: 'faq', system_text: 'S', user_text: 'U', options: { maxTokens: 9 } }] });
    const got = await S.claimRequests('w1', 99);
    assert.deepEqual(got, [{ id: 3, siteId: 8862, generatorId: 'faq', system: 'S', user: 'U', options: { maxTokens: 9 } }]);
    assert.match(issued[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(issued[0].sql, /status = 'pending' AND expires_at > now\(\) ORDER BY id/);
    assert.deepEqual(issued[0].params, ['w1', 5]);
  });
  test('only the worker holding the claim can answer, and a too-long or non-text answer is refused', async () => {
    respond = () => ({ rows: [], rowCount: 1 });
    assert.deepEqual(await S.completeRequest(3, 'w1', 'text'), { ok: true });
    assert.match(issued[0].sql, /WHERE id = \$1 AND worker_id = \$2 AND status = 'claimed'/);
    respond = () => ({ rows: [], rowCount: 0 });
    assert.deepEqual(await S.completeRequest(3, 'someone-else', 'text'), { ok: false });
    assert.equal((await S.completeRequest(3, 'w1', 123)).ok, false);
    const long = await S.completeRequest(3, 'w1', 'x'.repeat(S.MAX_RESPONSE_CHARS + 1));
    assert.equal(long.ok, false); assert.match(long.error, /more than the 90000/);
  });
  test('a failure is final unless the worker says it can be retried, and retries stop after the attempt cap', async () => {
    respond = () => ({ rows: [], rowCount: 1 });
    await S.failRequest(3, 'w1', 'bad', { retryable: false });
    assert.match(issued[0].sql, /SET status = 'failed'/);
    await S.failRequest(3, 'w1', 'timeout', { retryable: true });
    assert.match(issued[1].sql, /CASE WHEN attempts >= \$4 THEN 'failed' ELSE 'pending' END/);
    assert.equal(issued[1].params[3], S.MAX_ATTEMPTS);
  });
  test('a stopping worker gives back what it holds without costing an attempt', async () => {
    respond = () => ({ rows: [], rowCount: 2 });
    assert.deepEqual(await S.releaseRequests('w1'), { released: 2 });
    assert.match(issued[0].sql, /attempts = GREATEST\(attempts - 1, 0\)/);
  });
});

describe('who is connected, and housekeeping', () => {
  test('a worker is online when it reported within the window', async () => {
    respond = () => ({ rows: [{}] });
    assert.equal(await S.workerOnline(), true);
    assert.deepEqual(issued[0].params, [S.WORKER_ONLINE_MS]);
    respond = () => ({ rows: [] });
    assert.equal(await S.workerOnline(), false);
  });
  test('heartbeat records the worker and what it says about itself', async () => {
    await S.heartbeat('w1', { host: 'laptop' });
    assert.deepEqual(issued[0].params, ['w1', '{"host":"laptop"}']);
    assert.match(issued[0].sql, /ON CONFLICT \(worker_id\) DO UPDATE/);
  });
  test('sweep closes the stale, requeues a quiet claim, fails a request that exhausted its attempts, and purges old prompts (client page content)', async () => {
    await S.sweep();
    const sqls = issued.map((q) => q.sql);
    assert.ok(sqls.some((q) => /SET status = 'expired' WHERE status IN \('pending', 'claimed'\) AND expires_at < now\(\)/.test(q)));
    assert.ok(sqls.some((q) => /SET status = 'pending'/.test(q) && /attempts < \$2/.test(q)));
    assert.ok(sqls.some((q) => /SET status = 'failed'/.test(q) && /attempts >= \$2/.test(q)));
    const purge = issued.find((q) => /^DELETE FROM llm_requests/.test(q.sql));
    assert.match(purge.sql, /status IN \('done', 'failed', 'expired'\) AND created_at < now\(\)/);
    assert.deepEqual(purge.params, [S.RETENTION_DAYS]);
  });
  test('the status the dashboard reads', async () => {
    let n = 0;
    respond = () => ({ rows: n++ === 0 ? [{ status: 'done', n: 4 }, { status: 'pending', n: 1 }] : [{ n: 1 }] });
    assert.deepEqual(await S.queueStatus(), { requests: { done: 4, pending: 1 }, workersOnline: 1 });
  });
});
