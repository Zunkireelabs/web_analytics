import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crawlExternalCitations } from './technical-seo-analysis.js';

function stubFetchStatus(statusByUrl) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const status = statusByUrl[url] ?? 200;
    return { status, headers: { get: () => null } };
  };
  return () => { globalThis.fetch = original; };
}

// Regression coverage: page-content.js's externalCitationDomains only ever
// tracked distinct DOMAINS (for the hasExternalCitations >=2 signal) — no
// generator could ever act on a specific citation going dead since the real
// hrefs weren't kept anywhere. crawlExternalCitations reuses the same
// liveness-check machinery crawlInternalLinks already has (followRedirects)
// against the real hrefs (externalCitationLinks), so a stale citation
// routes to the same broken-link-fix generator as any other dead link.
describe('crawlExternalCitations', () => {
  test('flags a citation link that now 404s', async () => {
    const restore = stubFetchStatus({ 'https://source.example/gone': 404 });
    try {
      const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://source.example/gone'] } }];
      const result = await crawlExternalCitations(pageResults);
      assert.equal(result.checked, 1);
      assert.equal(result.broken.length, 1);
      assert.equal(result.broken[0].href, 'https://source.example/gone');
      assert.deepEqual(result.checkedPages, ['https://mysite.com/blog/post']);
    } finally { restore(); }
  });

  test('does not flag a citation link that still resolves', async () => {
    const restore = stubFetchStatus({ 'https://source.example/still-live': 200 });
    try {
      const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://source.example/still-live'] } }];
      const result = await crawlExternalCitations(pageResults);
      assert.equal(result.broken.length, 0);
    } finally { restore(); }
  });

  test('a page with no external citation links contributes nothing to check', async () => {
    const result = await crawlExternalCitations([{ page: 'https://mysite.com/x', analysis: { externalCitationLinks: [] } }]);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.broken, []);
  });

  test('bounded by maxChecks, same as crawlInternalLinks', async () => {
    const restore = stubFetchStatus({});
    try {
      const links = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'];
      const pageResults = [{ page: 'https://mysite.com/x', analysis: { externalCitationLinks: links } }];
      const result = await crawlExternalCitations(pageResults, 2);
      assert.equal(result.checked, 2);
    } finally { restore(); }
  });
});
