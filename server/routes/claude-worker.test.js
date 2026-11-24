import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const { requireWorkerToken, tokenMatches, makeHandlers } = await import('./claude-worker.js');

const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const req = (body = {}, params = {}, headers = {}) => ({ body, params, headers });

describe('the token', () => {
  test('without LLM_WORKER_TOKEN every route is a 404: the feature does not exist until it is turned on', () => {
    const r = res(); let called = false;
    requireWorkerToken(req({}, {}, { authorization: 'Bearer anything' }), r, () => { called = true; }, {});
    assert.deepEqual([r.code, called], [404, false]);
  });
  test('a missing or wrong token is a 401 and never reaches a handler', () => {
    for (const authorization of [undefined, '', 'Bearer ', 'Bearer wrong', 'Basic abc']) {
      const r = res(); let called = false;
      requireWorkerToken(req({}, {}, { authorization }), r, () => { called = true; }, { LLM_WORKER_TOKEN: 'secret-token' });
      assert.deepEqual([r.code, called], [401, false], String(authorization));
    }
  });
  test('the right token passes', () => {
    let called = false;
    requireWorkerToken(req({}, {}, { authorization: 'Bearer secret-token' }), res(), () => { called = true; }, { LLM_WORKER_TOKEN: 'secret-token' });
    assert.equal(called, true);
    assert.equal(tokenMatches('a', 'a'), true);
    assert.equal(tokenMatches('a', 'b'), false);
    assert.equal(tokenMatches('', 'b'), false);
  });
});

describe('the handlers', () => {
  const store = (over = {}) => ({
    heartbeat: async () => {}, sweep: async () => {}, claimRequests: async () => [], completeRequest: async () => ({ ok: true }),
    failRequest: async () => ({ ok: true }), releaseRequests: async () => ({ released: 0 }), queueStatus: async () => ({ requests: {}, workersOnline: 1 }), ...over,
  });
  const H = (s, extra = {}) => makeHandlers({ store: s, env: { LLM_WORKER_MODE: 'on' }, ...extra });

  test('a heartbeat records the worker and says whether the mode is on', async () => {
    let seen; const r = res();
    await H(store({ heartbeat: async (id, info) => { seen = [id, info]; } })).heartbeat(req({ workerId: 'laptop-1', info: { host: 'mac', version: '1' } }), r);
    assert.deepEqual(seen, ['laptop-1', { host: 'mac', version: '1' }]);
    assert.deepEqual(r.body, { ok: true, mode: 'on', fallback: 'none' });
  });
  test('a worker id that is not a plain name is refused', async () => {
    for (const workerId of [undefined, '', 'a', 'has space', 'x'.repeat(65), "a'; DROP TABLE x;--"]) {
      const r = res(); await H(store()).heartbeat(req({ workerId }), r); assert.equal(r.code, 400, String(workerId));
    }
  });
  test('claim hands out waiting requests at once, capped at 5', async () => {
    let asked; const r = res();
    await H(store({ claimRequests: async (id, limit) => { asked = [id, limit]; return [{ id: 1, system: 'S', user: 'U' }]; } })).claim(req({ workerId: 'laptop-1', limit: 99 }), r);
    assert.deepEqual(asked, ['laptop-1', 5]);
    assert.equal(r.body.requests.length, 1);
  });
  test('claim waits for work but never longer than 25 seconds, then answers with an empty list', async () => {
    let t = 0; let polls = 0; const r = res();
    await H(store({ claimRequests: async () => { polls++; return []; } }), { now: () => t, sleep: async (ms) => { t += ms; } }).claim(req({ workerId: 'laptop-1', waitMs: 600_000 }), r);
    assert.deepEqual(r.body, { requests: [] });
    assert.ok(t <= 26_000 && polls >= 20, `waited ${t}ms in ${polls} polls`);
  });
  test('claim with no wait answers immediately', async () => {
    let polls = 0; const r = res();
    await H(store({ claimRequests: async () => { polls++; return []; } })).claim(req({ workerId: 'laptop-1' }), r);
    assert.equal(polls, 1);
  });
  test('complete stores the text; not holding the request is a 409; a too-long answer is a 413; a bad id is a 400', async () => {
    let r = res(); await H(store()).complete(req({ workerId: 'laptop-1', text: 'hi' }, { id: '5' }), r); assert.deepEqual([r.code, r.body], [200, { ok: true }]);
    r = res(); await H(store({ completeRequest: async () => ({ ok: false }) })).complete(req({ workerId: 'laptop-1', text: 'hi' }, { id: '5' }), r); assert.equal(r.code, 409);
    r = res(); await H(store({ completeRequest: async () => ({ ok: false, error: 'too long' }) })).complete(req({ workerId: 'laptop-1', text: 'x' }, { id: '5' }), r); assert.equal(r.code, 413);
    r = res(); await H(store()).complete(req({ workerId: 'laptop-1', text: 'hi' }, { id: 'abc' }), r); assert.equal(r.code, 400);
  });
  test('fail passes on whether it can be retried', async () => {
    let seen; const r = res();
    await H(store({ failRequest: async (id, w, e, o) => { seen = [id, w, e, o]; return { ok: true }; } })).fail(req({ workerId: 'laptop-1', error: 'claude exited 1', retryable: true }, { id: '9' }), r);
    assert.deepEqual(seen, [9, 'laptop-1', 'claude exited 1', { retryable: true }]);
    await H(store({ failRequest: async (...a) => { seen = a; return { ok: true }; } })).fail(req({ workerId: 'laptop-1', error: 'x', retryable: 'yes' }, { id: '9' }), res());
    assert.deepEqual(seen[3], { retryable: false }, 'only a real true retries');
  });
  test('release gives back what the worker holds, only integer ids', async () => {
    let ids; const r = res();
    await H(store({ releaseRequests: async (w, i) => { ids = i; return { released: 2 }; } })).release(req({ workerId: 'laptop-1', ids: [1, 'x', 3.5, 4] }), r);
    assert.deepEqual(ids, [1, 4]);
    assert.deepEqual(r.body, { released: 2 });
  });
});
