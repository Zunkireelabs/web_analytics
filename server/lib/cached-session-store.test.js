import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CachedSessionStore } from './cached-session-store.js';

// A stand-in for the real (database) store that counts how often it is called.
function fakeInner() {
  const rows = new Map();
  const calls = { get: 0, set: 0, destroy: 0, touch: 0 };
  return {
    rows, calls,
    get: (sid, cb) => { calls.get++; cb(null, rows.has(sid) ? JSON.parse(rows.get(sid)) : null); },
    set: (sid, sess, cb) => { calls.set++; rows.set(sid, JSON.stringify(sess)); cb(null); },
    destroy: (sid, cb) => { calls.destroy++; rows.delete(sid); cb(null); },
    touch: (sid, sess, cb) => { calls.touch++; cb(null); },
  };
}
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));

describe('CachedSessionStore', () => {
  test('reads the database once for repeat reads inside the window, then again after it', async () => {
    let t = 0; const inner = fakeInner(); inner.rows.set('a', JSON.stringify({ userId: 1 }));
    const store = new CachedSessionStore(inner, { now: () => t, readTtlMs: 10_000 });
    assert.deepEqual(await call(store.get.bind(store), 'a'), { userId: 1 });
    t = 5_000; await call(store.get.bind(store), 'a');
    assert.equal(inner.calls.get, 1);
    t = 11_000; await call(store.get.bind(store), 'a');
    assert.equal(inner.calls.get, 2);
  });

  test('a saved change is seen on the very next read (never serves what it just changed)', async () => {
    const inner = fakeInner(); inner.rows.set('a', JSON.stringify({ siteId: 1 }));
    const store = new CachedSessionStore(inner, { now: () => 0 });
    await call(store.get.bind(store), 'a');
    await call(store.set.bind(store), 'a', { siteId: 2 });
    assert.deepEqual(await call(store.get.bind(store), 'a'), { siteId: 2 });
  });

  test('a signed-out session is gone at once', async () => {
    const inner = fakeInner(); inner.rows.set('a', JSON.stringify({ userId: 1 }));
    const store = new CachedSessionStore(inner, { now: () => 0 });
    await call(store.get.bind(store), 'a');
    await call(store.destroy.bind(store), 'a');
    assert.equal(await call(store.get.bind(store), 'a'), null);
  });

  test('a missing session is never cached as present', async () => {
    const inner = fakeInner();
    const store = new CachedSessionStore(inner, { now: () => 0 });
    assert.equal(await call(store.get.bind(store), 'nope'), null);
    inner.rows.set('nope', JSON.stringify({ userId: 9 }));
    assert.deepEqual(await call(store.get.bind(store), 'nope'), { userId: 9 });
  });

  test('a touch goes to the database at most once per interval', async () => {
    let t = 0; const inner = fakeInner();
    const store = new CachedSessionStore(inner, { now: () => t, touchEveryMs: 600_000 });
    await call(store.touch.bind(store), 'a', {});
    t = 60_000; await call(store.touch.bind(store), 'a', {});
    assert.equal(inner.calls.touch, 1);
    t = 700_000; await call(store.touch.bind(store), 'a', {});
    assert.equal(inner.calls.touch, 2);
  });

  test('callers get their own copy, so changing it cannot change the cache', async () => {
    const inner = fakeInner(); inner.rows.set('a', JSON.stringify({ n: 1 }));
    const store = new CachedSessionStore(inner, { now: () => 0 });
    const one = await call(store.get.bind(store), 'a'); one.n = 99;
    assert.deepEqual(await call(store.get.bind(store), 'a'), { n: 1 });
  });
});
