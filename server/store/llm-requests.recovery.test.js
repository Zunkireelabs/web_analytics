// Fault injection against the REAL queue on the LOCAL Postgres (sr-local-pg): worker killed mid-batch, restart, laptop asleep, a worker that never
// answers, two workers racing. Skipped in the normal test run (no database there); run with
//   DB_SSL=off DATABASE_URL=postgres://postgres:<local password>@localhost:55432/analytics node --experimental-test-module-mocks --test server/store/llm-requests.recovery.test.js
// (DB_SSL=off too: the local container has no TLS) and refuses to run against anything that is not the local container on port 55432.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = /@(localhost|127\.0\.0\.1):55432\//.test(process.env.DATABASE_URL || '');
const TAG = 'test-recovery';

describe('the worker queue under faults (real local Postgres)', { skip: !LOCAL }, () => {
  let q; let db;
  before(async () => { q = await import('./llm-requests.js'); db = await import('../db.js'); await db.query(`DELETE FROM llm_requests WHERE generator_id = $1`, [TAG]); });
  after(async () => { await db.query(`DELETE FROM llm_requests WHERE generator_id = $1`, [TAG]); await db.pool?.end?.(); });

  const enqueue = async (n) => { const ids = []; for (let i = 0; i < n; i++) ids.push(await q.enqueueRequest({ generatorId: TAG, system: 's', user: `u${i}`, ttlMs: 60 * 60_000 })); return ids; };
  const rows = async (ids) => (await db.query(`SELECT id, status, attempts, response_text, worker_id FROM llm_requests WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids])).rows;
  const backdate = (ids, minutes) => db.query(`UPDATE llm_requests SET claimed_at = now() - ($2::int * interval '1 minute') WHERE id = ANY($1::bigint[]) AND status = 'claimed'`, [ids, minutes]);

  test('a worker killed mid-batch: its completed answer survives, its unfinished requests come back at once, nothing is answered twice or lost', async () => {
    const ids = await enqueue(5);
    const first = await q.claimRequests('laptop-A', 3);
    assert.equal(first.length, 3);
    assert.deepEqual((await q.completeRequest(first[0].id, 'laptop-A', 'answer-from-before-the-kill')).ok, true);
    // ... the process is killed here: two requests are held, no goodbye was sent ...
    // The restarted worker gives back what the previous run held, immediately (worker.mjs does this at startup).
    const released = await q.releaseRequests('laptop-A');
    assert.equal(released.released, 2);
    const again = await q.claimRequests('laptop-A', 5);
    assert.equal(again.length, 4, 'the 2 given back + the 2 never claimed');
    for (const r of again) assert.equal((await q.completeRequest(r.id, 'laptop-A', `answer-${r.id}`)).ok, true);
    const final = await rows(ids);
    assert.ok(final.every((r) => r.status === 'done'), 'every request is answered');
    assert.equal(final[0].response_text, 'answer-from-before-the-kill', 'the answer written before the kill was not overwritten or lost');
    assert.ok(final.slice(1).every((r) => r.attempts === 1), 'the restart cost nobody an attempt');
  });

  test('a laptop that went to sleep without saying goodbye: after the stale-claim time the request is given to another worker', async () => {
    const [id] = await enqueue(1);
    await q.claimRequests('laptop-asleep', 1);
    await q.sweep();
    assert.equal((await rows([id]))[0].status, 'claimed', 'not given back before the stale time');
    await backdate([id], 6);
    await q.sweep();
    assert.equal((await rows([id]))[0].status, 'pending');
    const [claimed] = await q.claimRequests('laptop-B', 1);
    assert.equal(claimed.id, id);
    assert.equal((await q.completeRequest(id, 'laptop-B', 'ok')).ok, true);
    assert.equal((await q.completeRequest(id, 'laptop-asleep', 'late answer from the sleeper')).ok, false, 'the old holder cannot overwrite the new answer');
    const r = (await rows([id]))[0]; assert.deepEqual([r.status, r.response_text, r.attempts], ['done', 'ok', 2]);
  });

  test('a request nobody ever answers ends as FAILED with a reason after the attempt limit, never pending forever', async () => {
    const [id] = await enqueue(1);
    for (let i = 0; i < q.MAX_ATTEMPTS; i++) { await q.claimRequests(`ghost-${i}`, 1); await backdate([id], 6); await q.sweep(); }
    const r = (await db.query(`SELECT status, error FROM llm_requests WHERE id = $1`, [id])).rows[0];
    assert.equal(r.status, 'failed'); assert.match(r.error, /did not answer after several attempts/);
  });

  test('completed work is never touched by the housekeeping sweep', async () => {
    const [id] = await enqueue(1);
    await q.claimRequests('laptop-C', 1); await q.completeRequest(id, 'laptop-C', 'finished');
    await db.query(`UPDATE llm_requests SET claimed_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    await q.sweep();
    assert.deepEqual([(await rows([id]))[0].status, (await rows([id]))[0].response_text], ['done', 'finished']);
  });

  test('two workers racing for the same queue never take the same request', async () => {
    const ids = await enqueue(12);
    const [a, b] = await Promise.all([q.claimRequests('racer-A', 5), q.claimRequests('racer-B', 5)]);
    const taken = [...a, ...b].map((r) => r.id).filter((id) => ids.includes(id));
    assert.equal(new Set(taken).size, taken.length, 'no id claimed twice');
  });

  test('an expired request is never handed to a worker', async () => {
    const [id] = await enqueue(1);
    await db.query(`UPDATE llm_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    const got = await q.claimRequests('laptop-D', 5);
    assert.ok(!got.some((r) => r.id === id));
    await q.sweep();
    assert.equal((await rows([id]))[0].status, 'expired');
  });
});
