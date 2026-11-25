import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepoCategories } from './blog-outline.js';
// The verified-sources step makes its own model call and page fetches; these tests count model calls for other behaviour, so it is switched off here (it has its own tests: lib/verified-sources.test.js).
process.env.BLOG_SOURCES = 'off';

const site = { id: 1, repo_default_branch: 'main' };
const src = { file: 'src/content/blog/categories.json', slugPath: 'slug.current', titlePath: 'title' };
const cats = [{ title: 'UK', slug: { current: 'uk' } }, { title: 'Visa Guides', slug: { current: 'visa-guides' } }, { title: 'Broken' }];

test('reads the client repo file, maps slug/title by path, drops malformed items, never reaches a CMS', async () => {
  const r = await fetchRepoCategories(site, src, async () => ({ content: JSON.stringify(cats) }));
  assert.deepEqual(r, [{ title: 'UK', slug: 'uk' }, { title: 'Visa Guides', slug: 'visa-guides' }]);
  assert.equal(r.lookupFailed, undefined);
});
test('missing file, unreadable file, bad JSON or non-array are tagged lookupFailed (so a category-requiring site refuses, not guesses)', async () => {
  for (const f of [async () => null, async () => { throw new Error('x'); }, async () => ({ content: '{bad' }), async () => ({ content: '{}' })]) {
    const r = await fetchRepoCategories(site, src, f);
    assert.deepEqual([...r], []); assert.equal(r.lookupFailed, true);
  }
});
test('default paths are "slug" and "title"', async () => {
  const r = await fetchRepoCategories(site, { file: 'c.json' }, async () => ({ content: JSON.stringify([{ title: 'A', slug: 'a' }]) }));
  assert.deepEqual(r, [{ title: 'A', slug: 'a' }]);
});
