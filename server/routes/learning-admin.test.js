import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from './learning-admin.js';

const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
function setup(over = {}) {
  const audits = []; const calls = {};
  const h = createHandlers({
    getUser: async (id) => (id === 7 ? { id: 7, email: 'admin@example.test' } : null),
    audit: async (req, e) => audits.push(e),
    review: async (a) => { calls.review = a; return { id: a.id, review_state: a.state }; },
    promote: async (id, a) => { calls.promote = { id, ...a }; return { id, status: 'active' }; },
    rollback: async (a) => { calls.rollback = a; return { retiredId: 2, restoredId: 1 }; },
    ...over,
  });
  return { h, audits, calls };
}

test('the reviewer is the signed-in user, never something the request claims', async () => {
  const { h, audits, calls } = setup();
  const r = res();
  await h.review({ userId: 7, params: { id: '5' }, body: { state: 'quarantined', reason: 'looks wrong', by: 'someone-else@evil.test' } }, r, (e) => { throw e; });
  assert.equal(calls.review.by, 'admin@example.test');
  assert.equal(r.body.ok, true);
  assert.equal(audits[0].action, 'learning.review');
  assert.equal(audits[0].success, true);
  assert.deepEqual(Object.keys(audits[0].metadata), ['reason'], 'audit payload is allowlisted, not the whole body');
});

test('no signed-in user means 401 and nothing is written', async () => {
  const { h, calls, audits } = setup();
  const r = res();
  await h.review({ userId: 999, params: { id: '5' }, body: { state: 'rejected', reason: 'because it is bad' } }, r, () => {});
  assert.equal(r.code, 401);
  assert.equal(calls.review, undefined);
  assert.equal(audits[0].success, false);
});

test('a refused promotion is a 400 with the reason, and is audited as a failure', async () => {
  const { h, audits } = setup({ promote: async () => { throw new Error('Promotion refused: accuracy 0.5 does not beat 0.6'); } });
  const r = res();
  await h.promote({ userId: 7, params: { id: '3' }, body: { reason: 'try it' } }, r, (e) => { throw e; });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /does not beat/);
  assert.equal(audits[0].success, false);
  assert.equal(audits[0].action, 'model.promote');
});

test('an unexpected failure is passed on as a server error, not shown as a refusal', async () => {
  const { h } = setup({ promote: async () => { throw new Error('connection reset'); } });
  const r = res(); let passed = null;
  await h.promote({ userId: 7, params: { id: '3' }, body: { reason: 'try it' } }, r, (e) => { passed = e; });
  assert.equal(passed.message, 'connection reset');
});

test('bad ids are rejected before the library is called', async () => {
  const { h, calls } = setup();
  for (const id of ['0', '-1', 'abc', '1.5']) {
    const r = res();
    await h.review({ userId: 7, params: { id }, body: { state: 'approved', reason: 'checked it' } }, r, () => {});
    assert.equal(r.code, 400);
  }
  assert.equal(calls.review, undefined);
});

test('rollback and promote also use the session identity', async () => {
  const { h, calls } = setup();
  await h.rollback({ userId: 7, params: {}, body: { reason: 'outputs look off', by: 'spoof' } }, res(), () => {});
  assert.equal(calls.rollback.by, 'admin@example.test');
  await h.promote({ userId: 7, params: { id: '4' }, body: { reason: 'beats the baseline', by: 'spoof' } }, res(), () => {});
  assert.equal(calls.promote.by, 'admin@example.test');
});
