import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTemplatedSitemap } from './sitemap-guard.js';

test('a static sitemap.xml is safe to overwrite', () => {
  assert.equal(isTemplatedSitemap('<?xml version="1.0"?>\n<urlset><url><loc>https://x.test/</loc></url></urlset>'), false);
});
test('an Eleventy Nunjucks sitemap template is NOT (front matter + loop)', () => {
  const njk = '---\npermalink: "sitemap.xml"\n---\n<?xml version="1.0"?>\n<urlset>\n{%- for page in collections.all %}\n<url><loc>{{ page.url }}</loc></url>\n{%- endfor %}\n</urlset>';
  assert.equal(isTemplatedSitemap(njk), true);
});
test('front matter alone marks it as generated', () => {
  assert.equal(isTemplatedSitemap('---\npermalink: sitemap.xml\n---\n<urlset></urlset>'), true);
});
test('empty or missing content is not treated as a template', () => {
  assert.equal(isTemplatedSitemap(''), false);
  assert.equal(isTemplatedSitemap(null), false);
});
