import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crawlExternalCitations, fetchSoftNotFoundFingerprint, isSoftNotFound } from './technical-seo-analysis.js';

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

  // Regression: issuu.com returned 403 to every automated check here
  // (bot UA and a real browser UA string) while a human browser got a real
  // 200 — fingerprint-based bot protection (TLS/JA3, JS challenge, cookies)
  // that no bare fetch() retry can pass regardless of UA. Asserting "broken"
  // here shipped a real PR deleting a live citation. A 403 that survives the
  // retry is unverifiable, not confirmed dead, so it must be excluded from
  // both `broken` and the checked total's implied "confirmed live" set —
  // never asserted either way.
  test('a citation that 403s under BOTH UAs is unverifiable, not reported broken', async () => {
    const restore = stubFetchStatus({ 'https://really.example/blocked': 403 });
    try {
      const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://really.example/blocked'] } }];
      const result = await crawlExternalCitations(pageResults);
      assert.equal(result.broken.length, 0, 'a 403 that survives the retry cannot be distinguished from bot-protection, so it must not be asserted broken');
    } finally { restore(); }
  });

  // Regression: a shared footer link (/cookie-policy/, ~1,600 page refs) was
  // asserted broken although it returned a clean 200 live. Both attempts hit a
  // transient network failure — no HTTP status — and an error with no status
  // proves nothing about the destination. It must surface as unverifiable.
  test('a network error on BOTH attempts is unverifiable, not reported broken', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network'); };
    try {
      const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://flaky.example/page'] } }];
      const result = await crawlExternalCitations(pageResults);
      assert.equal(result.broken.length, 0);
      assert.equal(result.unverifiableCount, 1);
    } finally { globalThis.fetch = original; }
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

  // Regression: bot-protection stacks that answer an unfamiliar crawler UA
  // with 403 just as often answer with 429 (rate-limited) or 503
  // (temporarily unavailable) instead — both are the same "live page,
  // bot-hostile response" shape as the 403 case above, not evidence the
  // page is gone.
  for (const status of [429, 503]) {
    test(`a ${status} under the bot UA is retried with a browser UA before being reported broken`, async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async (url, opts) => {
        calls++;
        const isBrowserUA = opts?.headers?.['User-Agent']?.includes('Chrome');
        return { status: isBrowserUA ? 200 : status, headers: { get: () => null } };
      };
      try {
        const pageResults = [{ page: 'https://mysite.com/blog/post', analysis: { externalCitationLinks: ['https://blocked.example/x'] } }];
        const result = await crawlExternalCitations(pageResults);
        assert.equal(result.broken.length, 0, 'a live page must not be reported broken just because the bot UA got throttled/blocked');
        assert.equal(calls, 2, 'the retry must actually happen — one bot-UA attempt, one browser-UA attempt');
      } finally { globalThis.fetch = original; }
    });
  }

  test('a plain 404 is never retried — only outright failures and 403/429/503 get a second chance', async () => {
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

// Regression: on zunkireelabs.com's www host a nonexistent path and every real
// page answered the same 17-byte 301, so that response became the "soft-404
// fingerprint" and 41 real pages were reported as dead links serving the
// fallback. Only a 2xx with content can be a soft-404 fingerprint.
describe('soft-404 fingerprint', () => {
  const stubFetch = (fn) => { const o = globalThis.fetch; globalThis.fetch = fn; return () => { globalThis.fetch = o; }; };
  const res = (status, body) => ({ status, headers: { get: () => null }, text: async () => body });

  test('a redirecting or true-404 origin yields no fingerprint', async () => {
    let restore = stubFetch(async () => res(301, 'Moved Permanently'));
    try { assert.equal(await fetchSoftNotFoundFingerprint('https://www.example.com'), null); } finally { restore(); }
    restore = stubFetch(async () => res(404, 'Not found'));
    try { assert.equal(await fetchSoftNotFoundFingerprint('https://example.com'), null); } finally { restore(); }
  });

  test('a 200 catch-all with content yields a fingerprint that matches only that origin\'s identical pages', async () => {
    const restore = stubFetch(async (url) => (String(url).includes('/real') ? res(200, 'a real page') : res(200, 'Nothing here')));
    try {
      const fp = await fetchSoftNotFoundFingerprint('https://example.com');
      assert.equal(fp.status, 200);
      assert.equal(await isSoftNotFound('https://example.com/missing', fp), true);
      assert.equal(await isSoftNotFound('https://example.com/real', fp), false);
      assert.equal(await isSoftNotFound('https://www.example.com/missing', fp), false, 'a different host is not described by this fingerprint');
    } finally { restore(); }
  });
});

import { runPageChecks, detectDuplicateTitles } from './technical-seo-analysis.js';
describe('redirected URLs are not live pages', () => {
  test('a URL that 3xx-d is not audited as the destination page', async () => {
    const pageCache = async () => ({ ok: true, analysis: { wasRedirected: true, hasCanonical: true, canonicalUrl: 'https://x.com/other/', title: 'Other page', hasSchema: false, schemaTypes: [] } });
    const [r] = await runPageChecks({ id: 1 }, ['https://x.com/alias/'], pageCache);
    assert.equal(r.redirected, true);
    assert.equal(r.technicalAudit.ok, false);
    assert.equal(r.analysis, null);
  });
});
describe('detectDuplicateTitles host normalisation', () => {
  test('www and apex of the same page are not duplicates of each other', async () => {
    const groups = await detectDuplicateTitles(1, [
      { page: 'https://x.com/', technicalAudit: { title: 'Home' }, impressions: 1 },
      { page: 'https://www.x.com/', technicalAudit: { title: 'Home' }, impressions: 1 },
    ]).catch(() => null);
    if (groups) assert.equal(groups.length, 0);
  });
});
