import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStylesheetUrls, fingerprintOf, computeDesignFingerprint } from './design-fingerprint.js';

test('extracts stylesheet links only, resolved against the page', () => {
  const html = '<link rel="icon" href="/f.ico"><link rel="stylesheet" href="/a.css"><link href="b.css" rel="stylesheet"><link rel="stylesheet" href="/a.css">';
  assert.deepEqual(extractStylesheetUrls(html, 'https://x.test/p/'), ['https://x.test/a.css', 'https://x.test/p/b.css']);
});

test('fingerprint ignores order and changes when a part changes', () => {
  assert.equal(fingerprintOf(['a', 'b']), fingerprintOf(['b', 'a']));
  assert.notEqual(fingerprintOf(['a', 'b']), fingerprintOf(['a', 'c']));
});

const fakeFetch = (css) => async (url) => ({
  ok: true,
  text: async () => (String(url).endsWith('.css') ? css : '<link rel="stylesheet" href="/s.css">'),
});

test('same CSS gives the same fingerprint, different CSS a different one', async () => {
  const a = await computeDesignFingerprint('https://x.test/', { fetchFn: fakeFetch('body{color:red}') });
  const b = await computeDesignFingerprint('https://x.test/', { fetchFn: fakeFetch('body{color:red}') });
  const c = await computeDesignFingerprint('https://x.test/', { fetchFn: fakeFetch('body{color:blue}') });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('an unreadable site is null (no information), never a change', async () => {
  const bad = async () => ({ ok: false, status: 503, text: async () => '' });
  assert.equal(await computeDesignFingerprint('https://x.test/', { fetchFn: bad }), null);
});
