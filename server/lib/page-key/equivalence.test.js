import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { establishEquivalence, canonicalTagOf } from './equivalence.js';

// a fake web: url -> { finalUrl, html } or an Error
const web = (map) => ({ fetchPage: async (u) => { const r = map[u]; if (!r) throw new Error('404'); if (r instanceof Error) throw r; return { statusCode: 200, html: r.html || '', finalUrl: new URL(r.finalUrl || u) }; } });

describe('equivalence evidence', () => {
  test('a trailing-slash URL that redirects to the bare one is equivalent, by redirect', async () => {
    const r = await establishEquivalence('https://x.com/a/', 'https://x.com/a', web({ 'https://x.com/a/': { finalUrl: 'https://x.com/a' }, 'https://x.com/a': {} }));
    assert.equal(r.equivalent, true); assert.equal(r.basis, 'redirect');
  });
  test('http that redirects to https is equivalent, by redirect', async () => {
    const r = await establishEquivalence('http://x.com/a', 'https://x.com/a', web({ 'http://x.com/a': { finalUrl: 'https://x.com/a' }, 'https://x.com/a': {} }));
    assert.equal(r.equivalent, true); assert.equal(r.basis, 'redirect');
  });
  test('two URLs that both land on one final URL are equivalent', async () => {
    const r = await establishEquivalence('https://www.x.com/a', 'https://x.com/a/', web({ 'https://www.x.com/a': { finalUrl: 'https://x.com/a' }, 'https://x.com/a/': { finalUrl: 'https://x.com/a' } }));
    assert.equal(r.equivalent, true);
  });
  test('a canonical tag pointing at the other URL is evidence', async () => {
    const r = await establishEquivalence('https://x.com/a/', 'https://x.com/a', web({ 'https://x.com/a/': { html: '<link rel="canonical" href="https://x.com/a">' }, 'https://x.com/a': {} }));
    assert.equal(r.equivalent, true); assert.equal(r.basis, 'canonical');
  });
  test('both naming the same canonical is evidence, and a relative canonical is resolved', async () => {
    const r = await establishEquivalence('https://x.com/a/', 'https://x.com/a', web({ 'https://x.com/a/': { html: '<link href="/a" rel=canonical>' }, 'https://x.com/a': { html: '<link rel="canonical" href="https://x.com/a">' } }));
    assert.equal(r.equivalent, true);
  });
  test('both answering separately with no canonical is NOT evidence: they stay apart', async () => {
    const r = await establishEquivalence('https://x.com/a/', 'https://x.com/a', web({ 'https://x.com/a/': {}, 'https://x.com/a': {} }));
    assert.equal(r.equivalent, false);
  });
  test('an unreachable URL is NOT evidence', async () => {
    const r = await establishEquivalence('https://x.com/a/', 'https://x.com/a', web({ 'https://x.com/a': {} }));
    assert.equal(r.equivalent, false); assert.match(r.detail, /could not be fetched/);
  });
  test('path case is never merged by evidence that only shows a different-case page exists', async () => {
    const r = await establishEquivalence('https://x.com/About', 'https://x.com/about', web({ 'https://x.com/About': {}, 'https://x.com/about': {} }));
    assert.equal(r.equivalent, false);
  });
  test('a canonical pointing somewhere else entirely is not evidence', async () => {
    const r = await establishEquivalence('https://x.com/a/', 'https://x.com/a', web({ 'https://x.com/a/': { html: '<link rel="canonical" href="https://x.com/b">' }, 'https://x.com/a': {} }));
    assert.equal(r.equivalent, false);
  });
  test('canonicalTagOf reads attributes in either order and ignores other links', () => {
    assert.equal(canonicalTagOf('<link rel="stylesheet" href="/s.css"><link href="/p" rel="canonical">', 'https://x.com/q'), 'https://x.com/p');
    assert.equal(canonicalTagOf('<p>no tag</p>', 'https://x.com/'), null);
  });
});
