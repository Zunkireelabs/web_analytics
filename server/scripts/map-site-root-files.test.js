import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, mergeSiteRoot } from './map-site-root-files.js';

test('adds only what is missing or wrong and keeps every other key and the rest of the map', () => {
  const before = { pages: { '/a': { file: 'src/a.njk' } }, siteRoot: { robotsTxt: 'src/robots.txt', llmsTxt: 'src/llms.txt', nginxConfig: 'nginx/x.conf' } };
  const r = mergeSiteRoot(before, { llmsTxt: 'src/llms.njk' });
  assert.deepEqual(r.changed, ['llmsTxt']);
  assert.deepEqual(r.urlFileMap.siteRoot, { robotsTxt: 'src/robots.txt', llmsTxt: 'src/llms.njk', nginxConfig: 'nginx/x.conf' });
  assert.deepEqual(r.urlFileMap.pages, before.pages);
});
test('is idempotent, and works for a site with no siteRoot yet', () => {
  const once = mergeSiteRoot({ pages: {} }, { robotsTxt: 'public/robots.txt' });
  assert.deepEqual(once.urlFileMap.siteRoot, { robotsTxt: 'public/robots.txt' });
  assert.deepEqual(mergeSiteRoot(once.urlFileMap, { robotsTxt: 'public/robots.txt' }).changed, []);
});
test('the plan never maps a templated or framework-generated sitemap', () => {
  for (const [id, p] of Object.entries(PLAN)) {
    if (p.siteRoot.sitemap) assert.match(p.siteRoot.sitemap, /\.xml$/, `site ${id}: only a static .xml sitemap may be mapped`);
  }
  assert.equal(PLAN[8872].siteRoot.sitemap, undefined);
  assert.equal(PLAN[8871].siteRoot.sitemap, undefined);
  assert.equal(PLAN[1], undefined, 'zunkireelabs-web sitemap is a template');
});
