import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLocalAreaPattern, LOCAL_AREA_PATTERN } from './add-chayce-local-area-title-adapter.js';

test('adds the pattern once, keeps every existing page and pattern, and is idempotent', () => {
  const before = { _rev: 20, pages: { '/a': { file: 'src/a.njk' } }, patterns: [{ match: '^/blog/([^/]+)/?$', file: 'src/blog/$1.md' }], siteRoot: { x: 1 } };
  const first = withLocalAreaPattern(before);
  assert.equal(first.changed, true);
  assert.equal(first.urlFileMap.patterns.length, 2);
  assert.deepEqual(first.urlFileMap.pages, before.pages);
  assert.deepEqual(first.urlFileMap.siteRoot, before.siteRoot);
  assert.equal(withLocalAreaPattern(first.urlFileMap).changed, false);
});

test('a site with no patterns at all gets exactly the one', () => {
  const r = withLocalAreaPattern({ pages: {} });
  assert.deepEqual(r.urlFileMap.patterns, [LOCAL_AREA_PATTERN]);
});

test('the pattern catches the 20 towns and not the real pages next to them', () => {
  const re = new RegExp(LOCAL_AREA_PATTERN.match);
  for (const p of ['/elderly-removals-wellingborough/', '/elderly-removals-milton-keynes', '/elderly-removals-banbury/']) assert.equal(re.test(p), true, p);
  for (const p of ['/elderly-removals-faq', '/elderly-removals-cost-uk', '/elderly-removals-wellingborough-north/', '/blog/elderly-removals-cost-uk']) assert.equal(re.test(p), false, p);
});

test('it has no file entry, so no other fix can edit the shared template', () => {
  assert.equal('file' in LOCAL_AREA_PATTERN, false);
  assert.deepEqual(Object.keys(LOCAL_AREA_PATTERN.adapters), ['meta-title']);
});
