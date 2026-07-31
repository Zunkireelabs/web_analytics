import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { robotsAllowsAiCrawlers, analyzePage, contentGapsFor, isCompressedEncoding } from './page-content.js';

// Regression coverage for a real false-positive found in production: a
// robots.txt that correctly Allow's every real answer-engine crawler while
// disallowing only Bytespider (a training-data-only scraper, no live
// citation role) was being reported as robotsAllowsAiCrawlers: false,
// wrongly capping a real site's llmsReadiness score and re-surfacing an
// already-fixed "robots.txt blocks AI crawlers" finding on every
// subsequent audit run.

describe('robotsAllowsAiCrawlers', () => {
  test('true when every real answer-engine crawler is explicitly allowed, even if Bytespider is disallowed', () => {
    const robotsTxt = [
      'User-agent: *',
      'Allow: /blog/',
      'Disallow: /?*page=',
      'User-agent: GPTBot',
      'Allow: /',
      'User-agent: ClaudeBot',
      'Allow: /',
      'User-agent: PerplexityBot',
      'Allow: /',
      'User-agent: Google-Extended',
      'Allow: /',
      'User-agent: Applebot-Extended',
      'Allow: /',
      'User-agent: Bytespider',
      'Disallow: /',
    ].join('\n');
    assert.equal(robotsAllowsAiCrawlers(robotsTxt), true);
  });

  test('true when CCBot (training-data-only) is disallowed but real answer engines are not mentioned at all', () => {
    const robotsTxt = ['User-agent: *', 'Allow: /', 'User-agent: CCBot', 'Disallow: /'].join('\n');
    assert.equal(robotsAllowsAiCrawlers(robotsTxt), true);
  });

  test('false when a real answer-engine crawler is explicitly disallowed', () => {
    const robotsTxt = ['User-agent: GPTBot', 'Disallow: /'].join('\n');
    assert.equal(robotsAllowsAiCrawlers(robotsTxt), false);
  });

  test('false when the wildcard user-agent blocks everything site-wide', () => {
    const robotsTxt = ['User-agent: *', 'Disallow: /'].join('\n');
    assert.equal(robotsAllowsAiCrawlers(robotsTxt), false);
  });

  test('true for an empty/permissive robots.txt with no disallow rules at all', () => {
    assert.equal(robotsAllowsAiCrawlers('User-agent: *\nAllow: /'), true);
  });

  test('a partial-path disallow (not a bare "/") is not treated as a full block', () => {
    const robotsTxt = ['User-agent: GPTBot', 'Disallow: /admin/'].join('\n');
    assert.equal(robotsAllowsAiCrawlers(robotsTxt), true);
  });

  test('crawler token matching is case-insensitive', () => {
    const robotsTxt = ['User-agent: gptbot', 'Disallow: /'].join('\n');
    assert.equal(robotsAllowsAiCrawlers(robotsTxt), false);
  });
});

// GEO (Generative Engine Optimization) signals — confirmed via a real
// cross-check against the sibling audit tool's geo checks
// (authorExpertise.js/freshnessSignals.js/reviewRatingSchema.js/
// externalCitations.js): same detection logic, so a page verified by that
// tool and this one agree.
describe('analyzePage — GEO signals', () => {
  const PAGE_URL = 'https://example.com/blog/post';

  test('no author/freshness/review/citation signals on a bare page', () => {
    const html = '<html><body><p>Hello world.</p></body></html>';
    const a = analyzePage(html, PAGE_URL);
    assert.equal(a.hasAuthorSignal, false);
    assert.equal(a.hasFreshnessSignal, false);
    assert.equal(a.hasReviewSchema, false);
    assert.equal(a.externalCitationDomainCount, 0);
    assert.equal(a.hasExternalCitations, false);
  });

  test('author schema (JSON-LD) is detected', () => {
    const html = `<html><body><script type="application/ld+json">
      {"@type":"Article","author":{"@type":"Person","name":"Jane Doe"}}
    </script></body></html>`;
    assert.equal(analyzePage(html, PAGE_URL).hasAuthorSignal, true);
  });

  test('a visible byline class is detected without any schema', () => {
    const html = '<html><body><span class="byline">By Jane Doe</span></body></html>';
    assert.equal(analyzePage(html, PAGE_URL).hasAuthorSignal, true);
  });

  test('rel="author" link is detected', () => {
    const html = '<html><body><a rel="author" href="/about">Jane Doe</a></body></html>';
    assert.equal(analyzePage(html, PAGE_URL).hasAuthorSignal, true);
  });

  test('datePublished schema is detected as a freshness signal', () => {
    const html = `<html><body><script type="application/ld+json">
      {"@type":"Article","datePublished":"2026-01-01"}
    </script></body></html>`;
    assert.equal(analyzePage(html, PAGE_URL).hasFreshnessSignal, true);
  });

  test('article:modified_time meta tag is detected as a freshness signal', () => {
    const html = '<html><head><meta property="article:modified_time" content="2026-01-01"></head><body></body></html>';
    assert.equal(analyzePage(html, PAGE_URL).hasFreshnessSignal, true);
  });

  test('a <time datetime> element is detected as a freshness signal', () => {
    const html = '<html><body><time datetime="2026-01-01">Jan 1</time></body></html>';
    assert.equal(analyzePage(html, PAGE_URL).hasFreshnessSignal, true);
  });

  test('Review schema type is detected', () => {
    const html = `<html><body><script type="application/ld+json">
      {"@type":"Review","reviewBody":"Great product"}
    </script></body></html>`;
    assert.equal(analyzePage(html, PAGE_URL).hasReviewSchema, true);
  });

  test('a nested aggregateRating (ratingValue + reviewCount) is detected without an explicit AggregateRating @type', () => {
    const html = `<html><body><script type="application/ld+json">
      {"@type":"Product","aggregateRating":{"ratingValue":"4.5","reviewCount":"120"}}
    </script></body></html>`;
    assert.equal(analyzePage(html, PAGE_URL).hasReviewSchema, true);
  });

  test('a @graph entry is inspected the same as a top-level JSON-LD block', () => {
    const html = `<html><body><script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[{"@type":"Article","author":{"name":"Jane Doe"},"datePublished":"2026-01-01"}]}
    </script></body></html>`;
    const a = analyzePage(html, PAGE_URL);
    assert.equal(a.hasAuthorSignal, true);
    assert.equal(a.hasFreshnessSignal, true);
  });

  test('external citations: 2+ distinct outside domains passes, self-links and duplicates never count', () => {
    const html = `<html><body>
      <a href="https://example.com/other-page">self</a>
      <a href="https://wikipedia.org/x">source 1</a>
      <a href="https://wikipedia.org/y">source 1 again, same domain</a>
      <a href="https://nytimes.com/z">source 2</a>
    </body></html>`;
    const a = analyzePage(html, PAGE_URL);
    assert.equal(a.externalCitationDomainCount, 2);
    assert.equal(a.hasExternalCitations, true);
  });

  test('external citations: exactly 1 distinct outside domain does not pass the >=2 threshold', () => {
    const html = '<html><body><a href="https://wikipedia.org/x">source</a></body></html>';
    const a = analyzePage(html, PAGE_URL);
    assert.equal(a.externalCitationDomainCount, 1);
    assert.equal(a.hasExternalCitations, false);
  });
});

describe('isCompressedEncoding', () => {
  test('true for gzip, br, and deflate', () => {
    assert.equal(isCompressedEncoding('gzip'), true);
    assert.equal(isCompressedEncoding('br'), true);
    assert.equal(isCompressedEncoding('deflate'), true);
  });

  test('true for a case-different or combined value (e.g. "gzip, br")', () => {
    assert.equal(isCompressedEncoding('GZIP'), true);
    assert.equal(isCompressedEncoding('gzip, br'), true);
  });

  test('false for a missing or non-compressing value', () => {
    assert.equal(isCompressedEncoding(null), false);
    assert.equal(isCompressedEncoding(undefined), false);
    assert.equal(isCompressedEncoding(''), false);
    assert.equal(isCompressedEncoding('identity'), false);
  });
});

describe('contentGapsFor — GEO gap types', () => {
  const baseAnalysis = {
    title: 'A perfectly good title for this page', metaDescription: 'A'.repeat(80),
    hasMetaDescription: true, hasFaq: true, hasSchema: true, h1Count: 1, h2Count: 1,
    hasComparisonContent: true, imagesTotal: 0, imagesWithoutAlt: 0, hasCanonical: true,
    canonicalUrl: null, pageHost: null, hasOpenGraph: true, listCount: 1, questionHeadingCount: 1,
    hasAuthorSignal: true, hasFreshnessSignal: true, hasReviewSchema: true,
    externalCitationDomainCount: 3, hasExternalCitations: true,
  };

  test('no GEO gaps reported when every GEO signal is present', () => {
    const gaps = contentGapsFor(baseAnalysis, []);
    const geoTypes = gaps.map((g) => g.type).filter((t) => t.includes('author') || t.includes('freshness') || t.includes('review') || t.includes('citations'));
    assert.deepEqual(geoTypes, []);
  });

  test('missing author/freshness/review/citation signals each produce their own gap', () => {
    const analysis = { ...baseAnalysis, hasAuthorSignal: false, hasFreshnessSignal: false, hasReviewSchema: false, hasExternalCitations: false, externalCitationDomainCount: 0 };
    const gaps = contentGapsFor(analysis, []).map((g) => g.type);
    assert.ok(gaps.includes('Missing author/expertise signal'));
    assert.ok(gaps.includes('Missing freshness signal'));
    assert.ok(gaps.includes('Missing review/rating schema'));
    assert.ok(gaps.includes('Missing external citations'));
  });
});
