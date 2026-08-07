import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPageMapped } from './url-file-map.js';

// Regression coverage for a real report: zunkireelabs-web's `/compare/:slug`
// pattern configures `adapters` for faq/meta-title only (no `file`, no
// `schema` adapter) — a schema recommendation for
// /compare/zunkiree-vs-elasticsearch/ generated an "auto-eligible" card that
// failed every time someone tried to apply it ("No url_file_map entry
// matches..."). isPageMapped is the pre-check that lets
// agents/lib/recommendations.js skip creating that recommendation at all.
describe('isPageMapped', () => {
  const site = {
    url_file_map: {
      pages: { '/about': { file: 'src/pages/about.njk' } },
      patterns: [
        {
          match: '^/compare/([^/]+)$',
          adapters: {
            faq: { id: 'data-array-content', dataFile: 'src/_data/comparisons.js', itemsField: 'faqs' },
            'meta-title': { id: 'data-array-content', dataFile: 'src/_data/comparisons.js', fields: { title: 'title' } },
          },
        },
        { match: '^/blog/([^/]+)$', file: 'src/blog/$1.md' },
      ],
    },
  };

  test('a page with no adapter and no file/pattern match is not mapped', () => {
    assert.equal(isPageMapped(site, 'https://example.com/compare/zunkiree-vs-elasticsearch/', 'schema'), false);
  });

  test('an action type with an adapter route counts as mapped, even without a `file`', () => {
    assert.equal(isPageMapped(site, 'https://example.com/compare/zunkiree-vs-elasticsearch/', 'faq'), true);
    assert.equal(isPageMapped(site, 'https://example.com/compare/zunkiree-vs-elasticsearch/', 'meta-title'), true);
  });

  test('an exact `pages` entry with a real file counts as mapped for any action type', () => {
    assert.equal(isPageMapped(site, 'https://example.com/about', 'schema'), true);
  });

  test('a `patterns` entry with a real file counts as mapped for any action type', () => {
    assert.equal(isPageMapped(site, 'https://example.com/blog/my-post', 'schema'), true);
  });

  test('a page matching nothing at all is not mapped', () => {
    assert.equal(isPageMapped(site, 'https://example.com/nowhere', 'schema'), false);
  });
});
