import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePageMove, samePage } from './redirect-resolution.js';

// Scripted fetch: { url: [status, location?] }
const scripted = (table) => async (url) => {
  const row = table[url];
  if (!row) throw new Error(`unexpected fetch ${url}`);
  const [status, location] = row;
  return { status, headers: { get: (h) => (h.toLowerCase() === 'location' ? location || null : null) } };
};

describe('samePage', () => {
  test('ignores scheme, www, trailing slash and path case', () => {
    assert.equal(samePage('http://www.a.com/Blog/x/', 'https://a.com/blog/x'), true);
  });
  test('a different path is a different page', () => {
    assert.equal(samePage('https://a.com/blog/x', 'https://a.com/businesses/blog/x'), false);
  });
});

describe('resolvePageMove', () => {
  test('a 308 to a different path on the same site is a move', async () => {
    const r = await resolvePageMove('https://a.com/blog/x/', { fetchImpl: scripted({
      'https://a.com/blog/x/': [308, 'https://a.com/blog/x'],
      'https://a.com/blog/x': [308, 'https://a.com/businesses/blog/x'],
      'https://a.com/businesses/blog/x': [200],
    }) });
    assert.equal(r.ok, true); assert.equal(r.moved, true); assert.equal(r.permanent, true);
    assert.equal(r.finalUrl, 'https://a.com/businesses/blog/x'); assert.equal(r.hops.length, 2);
  });

  test('a trailing-slash-only redirect is NOT a move', async () => {
    const r = await resolvePageMove('https://a.com/about', { fetchImpl: scripted({
      'https://a.com/about': [301, 'https://a.com/about/'], 'https://a.com/about/': [200],
    }) });
    assert.equal(r.moved, false); assert.equal(r.ok, true);
  });

  test('a plain 200 is not a move', async () => {
    const r = await resolvePageMove('https://a.com/x', { fetchImpl: scripted({ 'https://a.com/x': [200] }) });
    assert.deepEqual([r.ok, r.moved, r.hops.length], [true, false, 0]);
  });

  test('a redirect to ANOTHER site is reported, never followed, and is not a move of this page', async () => {
    const r = await resolvePageMove('https://a.com/x', { fetchImpl: scripted({ 'https://a.com/x': [301, 'https://other.com/x'] }) });
    assert.equal(r.leftSite, true); assert.equal(r.moved, false);
  });

  test('a redirect loop gives up and is not evidence of anything', async () => {
    const r = await resolvePageMove('https://a.com/a', { fetchImpl: scripted({ 'https://a.com/a': [302, 'https://a.com/b'], 'https://a.com/b': [302, 'https://a.com/a'] }) });
    assert.equal(r.ok, false); assert.equal(r.moved, false); assert.equal(r.error, 'too-many-redirects');
  });

  test('a network failure is ok:false, never "moved"', async () => {
    const r = await resolvePageMove('https://a.com/x', { fetchImpl: async () => { throw new Error('boom'); } });
    assert.deepEqual([r.ok, r.moved], [false, false]);
  });

  test('a private address is refused before any request', async () => {
    let called = false;
    const r = await resolvePageMove('http://127.0.0.1/x', { fetchImpl: async () => { called = true; } });
    assert.equal(called, false); assert.equal(r.error, 'private-address');
  });
});
