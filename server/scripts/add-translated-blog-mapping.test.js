import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTranslatedBlogRule, TRANSLATED_BLOG_RULE } from './add-translated-blog-mapping.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';

const base = { pages: { '/nl/blog/old/': { file: 'src/nl/blog/old.md' } }, patterns: [{ match: '^/blog/([^/]+)/?$', file: 'src/blog/$1.md' }] };

test('adds the rule once, keeps everything else, and is idempotent', () => {
  const r = withTranslatedBlogRule(base);
  assert.equal(r.changed, true);
  assert.equal(r.urlFileMap.patterns.length, 2);
  assert.deepEqual(r.urlFileMap.pages, base.pages);
  assert.equal(withTranslatedBlogRule(r.urlFileMap).changed, false);
});

test('resolves every translated language to src/<lang>/blog/<slug>.md, including a language code with a dash', () => {
  const site = { url_file_map: withTranslatedBlogRule(base).urlFileMap };
  assert.equal(resolveFile(site, 'https://zunkireelabs.com/nl/blog/een-bericht/'), 'src/nl/blog/een-bericht.md');
  assert.equal(resolveFile(site, 'https://zunkireelabs.com/de/blog/ein-beitrag/'), 'src/de/blog/ein-beitrag.md');
  assert.equal(resolveFile(site, 'https://zunkireelabs.com/de-ch/blog/ein-beitrag/'), 'src/de-ch/blog/ein-beitrag.md');
});

test('an explicit page entry still wins, and the English rule and other paths are untouched', () => {
  const site = { url_file_map: withTranslatedBlogRule({ ...base, pages: { '/nl/blog/special/': { file: 'src/custom/special.md' } } }).urlFileMap };
  assert.equal(resolveFile(site, 'https://x.com/nl/blog/special/'), 'src/custom/special.md');
  assert.equal(resolveFile(site, 'https://x.com/blog/hello/'), 'src/blog/hello.md');
  assert.equal(resolveFile(site, 'https://x.com/nl/about/'), null);
  assert.equal(resolveFile(site, 'https://x.com/nl/blog/'), null, 'the listing itself is not a post');
});

test('the rule has no adapters, so it can only point a fix at the post\'s own file', () => {
  assert.deepEqual(Object.keys(TRANSLATED_BLOG_RULE).sort(), ['file', 'match']);
});
