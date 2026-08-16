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

  // Regression: linkedin.com/company/zunkiree and a Couchbase blog post both
  // 403'd under UA_HEADER's self-identifying bot UA while being genuinely
  // live (real browser UA returned 200) — bot-protected sites routinely
  // block an unfamiliar UA string, so a lone 403 is not proof a citation is
  // actually dead. Two of these false positives had already shipped as real
  // PRs deleting live citations before this was caught.
  test('a 403 under the bot UA is retried with a browser UA before being reported broken', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, opts) => {
      calls++;
      const isBrowserUA = opts?.headers?.['User-Agent']?.includes('Chrome');
      return { status: isBrowserUA ? 200 : 403, headers: { get: () => null } };
    };
    try {
      const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://linkedin.example/company/x'] } }];
      const result = await crawlExternalCitations(pageResults);
      assert.equal(result.broken.length, 0, 'a live page must not be reported broken just because the bot UA got blocked');
      assert.equal(calls, 2, 'the retry must actually happen — one bot-UA attempt, one browser-UA attempt');
    } finally { globalThis.fetch = original; }
  });

  test('a citation that 403s under BOTH UAs is still reported broken', async () => {
    const restore = stubFetchStatus({ 'https://really.example/gone': 403 });
    try {
      const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://really.example/gone'] } }];
      const result = await crawlExternalCitations(pageResults);
      assert.equal(result.broken.length, 1, 'a genuine 403 that survives the retry is still reported broken');
    } finally { restore(); }
  });

  test('a network error on the first attempt is retried, not reported broken outright', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, opts) => {
      calls++;
      const isBrowserUA = opts?.headers?.['User-Agent']?.includes('Chrome');
      if (!isBrowserUA) throw new Error('timeout');
      return { status: 200, headers: { get: () => null } };
    };
    try {
      const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://slow.example/page'] } }];
      const result = await crawlExternalCitations(pageResults);
      assert.equal(result.broken.length, 0, 'a slow site that answers on retry must not be reported broken');
      assert.equal(calls, 2);
    } finally { globalThis.fetch = original; }
  });

  test('a plain 404 is never retried — only outright failures and 403 get a second chance', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { status: 404, headers: { get: () => null } }; };
    try {
      const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://really.example/404'] } }];
      const result = await crawlExternalCitations(pageResults);
      assert.equal(result.broken.length, 1);
      assert.equal(calls, 1, 'an honest 404 must not spend a second request retrying it');
    } finally { globalThis.fetch = original; }
  });
});
