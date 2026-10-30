import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hit, authRateLimit } from './rate-limit.js';

const mkRes = () => ({ code: 200, headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

describe('hit', () => {
  test('within the limit is allowed, past it is not', async () => {
    let n = 0;
    const run = async () => ({ rows: [{ count: ++n, retry_after: 120 }] });
    assert.equal((await hit('k', 2, 60, { run })).allowed, true);
    assert.equal((await hit('k', 2, 60, { run })).allowed, true);
    const third = await hit('k', 2, 60, { run });
    assert.deepEqual([third.allowed, third.retryAfter], [false, 120]);
  });
  test('a broken store fails open', async () => {
    const run = async () => { throw new Error('db down'); };
    assert.equal((await hit('k', 1, 60, { run })).allowed, true);
  });
});

describe('authRateLimit', () => {
  const mk = (hitFn) => authRateLimit({ hitFn, limits: { '/login': { ip: [2, 60], email: [1, 60] } } });
  test('other paths and methods pass through untouched', async () => {
    let called = 0; const mw = mk(async () => { called++; return { allowed: true }; });
    await mw({ method: 'GET', path: '/login', ip: '1.1.1.1', body: {} }, mkRes(), () => {});
    await mw({ method: 'POST', path: '/other', ip: '1.1.1.1', body: {} }, mkRes(), () => {});
    assert.equal(called, 0);
  });
  test('limits by IP and by normalised address, and 429s with Retry-After', async () => {
    const seen = [];
    const mw = mk(async (key) => { seen.push(key); return key.startsWith('em:') ? { allowed: false, retryAfter: 90 } : { allowed: true }; });
    const res = mkRes(); let nexted = false;
    await mw({ method: 'POST', path: '/login', ip: '9.9.9.9', body: { email: ' A@B.com ' } }, res, () => { nexted = true; });
    assert.deepEqual(seen, ['ip:/login:9.9.9.9', 'em:/login:a@b.com']);
    assert.equal(res.code, 429);
    assert.equal(res.headers['Retry-After'], '90');
    assert.equal(res.body.code, 'RATE_LIMITED');
    assert.equal(nexted, false);
  });
  test('case and a trailing slash do not slip past the limit', async () => {
    for (const path of ['/LOGIN', '/login/', '/Login//']) {
      const seen = [];
      const mw = mk(async (key) => { seen.push(key); return { allowed: false, retryAfter: 60 }; });
      const res = mkRes();
      await mw({ method: 'POST', path, ip: '9.9.9.9', body: { email: 'a@b.com' } }, res, () => {});
      assert.equal(res.code, 429, path);
      assert.equal(seen[0], 'ip:/login:9.9.9.9');
    }
  });
  test('an allowed request goes on', async () => {
    const mw = mk(async () => ({ allowed: true })); let nexted = false;
    await mw({ method: 'POST', path: '/login', ip: '1.1.1.1', body: { email: 'a@b.com' } }, mkRes(), () => { nexted = true; });
    assert.equal(nexted, true);
  });
});
