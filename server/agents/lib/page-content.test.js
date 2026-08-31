import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { robotsAllowsAiCrawlers, analyzePage, contentGapsFor, isCompressedEncoding, llmsTxtHasValidStructure, titleKeywordConsistency, inferSchemaType, MAX_INLINE_STYLE_COUNT, MIN_GROUNDING_WORDS, hasSufficientGroundingContent, requireGroundedContent } from './page-content.js';

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

// Regression coverage for a real production case (zunkireelabs.com): the
// site's live llms.txt returns 200 with text/plain content-type — passing
// the bare existence check — but is a plain "Key Pages:" list with no "#
// Title" heading and no markdown links, so it doesn't actually follow the
// llms.txt convention and gives AI crawlers nothing structured to parse.
describe('llmsTxtHasValidStructure', () => {
  test('true for a well-formed file: top-level heading plus at least one markdown link', () => {
    const text = '# Acme Inc\n\nAcme sells widgets.\n\n## Key Pages\n- [Pricing](https://acme.com/pricing)';
    assert.equal(llmsTxtHasValidStructure(text), true);
  });

  test('false for a real production example: plain-text list, no heading, no markdown links', () => {
    const text = 'Key Pages:\n- URL: https://zunkireelabs.com/blog Title: Blog Meta Description: Our blog';
    assert.equal(llmsTxtHasValidStructure(text), false);
  });

  test('false when a markdown link exists but there is no top-level heading', () => {
    const text = 'Some intro text.\n- [Pricing](https://acme.com/pricing)';
    assert.equal(llmsTxtHasValidStructure(text), false);
  });

  test('false when a heading exists but there are no markdown links', () => {
    const text = '# Acme Inc\n\nAcme sells widgets. Visit https://acme.com/pricing for pricing.';
    assert.equal(llmsTxtHasValidStructure(text), false);
  });

  test('false for empty or missing content', () => {
    assert.equal(llmsTxtHasValidStructure(''), false);
    assert.equal(llmsTxtHasValidStructure(null), false);
    assert.equal(llmsTxtHasValidStructure(undefined), false);
  });

  test('a "#" inside body text (not at the start of a line) does not count as a heading', () => {
    const text = 'This costs #5 per unit.\n- [Pricing](https://acme.com/pricing)';
    assert.equal(llmsTxtHasValidStructure(text), false);
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

  // Regression coverage: only the DOMAIN set was ever kept, so nothing
  // could liveness-check a specific citation later — technical-seo-
  // analysis.js's crawlExternalCitations needs the real hrefs themselves.
  test('externalCitationLinks captures the real hrefs, not just their domains, self-links excluded', () => {
    const html = `<html><body>
      <a href="https://example.com/other-page">self</a>
      <a href="https://wikipedia.org/x">source 1</a>
      <a href="https://nytimes.com/z">source 2</a>
    </body></html>`;
    const a = analyzePage(html, PAGE_URL);
    assert.deepEqual(a.externalCitationLinks.sort(), ['https://nytimes.com/z', 'https://wikipedia.org/x']);
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

describe('contentGapsFor — Missing breadcrumbs gap', () => {
  const baseAnalysis = {
    title: 'A perfectly good title for this page', metaDescription: 'A'.repeat(80),
    hasMetaDescription: true, hasFaq: true, hasSchema: true, h1Count: 1, h2Count: 1,
    hasComparisonContent: true, imagesTotal: 0, imagesWithoutAlt: 0, hasCanonical: true,
    canonicalUrl: null, pageHost: null, hasOpenGraph: true, listCount: 1, questionHeadingCount: 1,
    hasAuthorSignal: true, hasFreshnessSignal: true, hasReviewSchema: true,
    externalCitationDomainCount: 3, hasExternalCitations: true, schemaTypes: [],
  };

  test('flags missing breadcrumbs on a non-root page with no BreadcrumbList schema', () => {
    const gaps = contentGapsFor({ ...baseAnalysis, isRootPage: false }, []).map((g) => g.type);
    assert.ok(gaps.includes('Missing breadcrumbs'));
  });

  test('does not flag missing breadcrumbs on the site root — breadcrumbs.js refuses to draft a trail for it', () => {
    const gaps = contentGapsFor({ ...baseAnalysis, isRootPage: true }, []).map((g) => g.type);
    assert.ok(!gaps.includes('Missing breadcrumbs'));
  });

  test('does not flag missing breadcrumbs when BreadcrumbList schema is already present', () => {
    const gaps = contentGapsFor({ ...baseAnalysis, isRootPage: false, schemaTypes: ['BreadcrumbList'] }, []).map((g) => g.type);
    assert.ok(!gaps.includes('Missing breadcrumbs'));
  });
});

describe('titleKeywordConsistency', () => {
  test('not checked when the title is empty or only stopwords', () => {
    assert.equal(titleKeywordConsistency('', 'some body text').checked, false);
    assert.equal(titleKeywordConsistency('The And Of', 'some body text').checked, false);
  });

  test('ratio 1 when every real title keyword appears in the body', () => {
    const result = titleKeywordConsistency('Best Hiking Boots for Winter', 'Our best winter hiking boots are built for cold trails.');
    assert.equal(result.checked, true);
    assert.equal(result.ratio, 1);
    assert.deepEqual(result.missingWords, []);
  });

  test('ratio reflects the fraction of title keywords missing from the body, case-insensitively', () => {
    const result = titleKeywordConsistency('Best Scuba Diving Gear', 'This page talks about hiking boots only.');
    assert.equal(result.checked, true);
    assert.ok(result.ratio < 0.5);
    assert.ok(result.missingWords.includes('scuba'));
    assert.ok(result.missingWords.includes('diving'));
  });
});

describe('contentGapsFor — Keyword consistency gap', () => {
  const baseAnalysis = {
    title: 'A perfectly good title for this page', metaDescription: 'A'.repeat(80),
    hasMetaDescription: true, hasFaq: true, hasSchema: true, h1Count: 1, h2Count: 1,
    hasComparisonContent: true, imagesTotal: 0, imagesWithoutAlt: 0, hasCanonical: true,
    canonicalUrl: null, pageHost: null, hasOpenGraph: true, listCount: 1, questionHeadingCount: 1,
    hasAuthorSignal: true, hasFreshnessSignal: true, hasReviewSchema: true,
    externalCitationDomainCount: 3, hasExternalCitations: true,
    bodyText: 'A perfectly good page about this exact title and topic, written in full.',
  };

  test('no gap when the title\'s real keywords show up in the body', () => {
    const gaps = contentGapsFor(baseAnalysis, []).map((g) => g.type);
    assert.ok(!gaps.includes('Keyword consistency'));
  });

  test('flags a gap when the title\'s keywords are absent from the body', () => {
    const analysis = { ...baseAnalysis, title: 'Scuba Diving Equipment Reviews', bodyText: 'This page is actually about hiking trails and camping gear.' };
    const gaps = contentGapsFor(analysis, []).map((g) => g.type);
    assert.ok(gaps.includes('Keyword consistency'));
  });
});

describe('analyzePage — isRootPage', () => {
  const html = '<html><body><p>Hello world.</p></body></html>';

  test('true for the bare domain root', () => {
    assert.equal(analyzePage(html, 'https://example.com/').isRootPage, true);
    assert.equal(analyzePage(html, 'https://example.com').isRootPage, true);
  });

  test('false for any real subpath', () => {
    assert.equal(analyzePage(html, 'https://example.com/about/').isRootPage, false);
  });
});

describe('analyzePage — page-weight signals', () => {
  test('counts elements with a style="" attribute', () => {
    const html = `<html><head><title>T</title></head><body>${'<div style="color:red">x</div>'.repeat(3)}<p>no style here</p></body></html>`;
    const analysis = analyzePage(html, 'https://example.com/');
    assert.equal(analysis.inlineStyleCount, 3);
  });

  test('reports the real byte size of the fetched HTML', () => {
    const html = '<html><head><title>T</title></head><body>hello</body></html>';
    const analysis = analyzePage(html, 'https://example.com/');
    assert.equal(analysis.htmlByteSize, Buffer.byteLength(html, 'utf8'));
  });

  test('MAX_INLINE_STYLE_COUNT is a positive threshold', () => {
    assert.ok(MAX_INLINE_STYLE_COUNT > 0);
  });
});

// Regression coverage for a real systemic bug: analyzePage()'s bodyText
// used to be a raw `$('body').text()` with no boilerplate stripping and no
// content-container targeting, so it always included nav/header/footer
// text verbatim — every LLM generator that grounds itself in bodyText
// (schema, faq, qa-content, meta-title, expand-content, internal-links,
// translation, open-graph) inherited that risk. These tests pin the fixed
// behavior directly, since analyzePage() is pure (takes an html string, no
// network) and every consuming generator's own test just stubs fetch to
// reach this same code path.
describe('analyzePage — main content extraction', () => {
  const REAL_PARAGRAPH = 'This is a real, substantial paragraph of genuine article content about the topic at hand, '
    + 'written with enough real words to clear the grounding floor for a realistic test of extraction behavior. '.repeat(3);
  const NAV = '<nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/pricing">Pricing</a></nav>';
  const FOOTER = '<footer>Copyright 2026 Example Co. All rights reserved. Privacy Policy | Terms of Service</footer>';

  test('bodyText excludes nav/header/footer text even when a real <article> exists', () => {
    const html = `<html><head><title>T</title></head><body>${NAV}` +
      `<header><div class="site-header">Example Co</div></header>` +
      `<article><h1>Real Article</h1><p>${REAL_PARAGRAPH}</p></article>${FOOTER}</body></html>`;
    const { bodyText, mainContentSelector } = analyzePage(html, 'https://example.com/page');
    assert.ok(!/Home|About|Contact|Pricing/.test(bodyText), 'nav links leaked into bodyText');
    assert.ok(!/Copyright|Privacy Policy|Terms of Service/.test(bodyText), 'footer text leaked into bodyText');
    assert.ok(!/Example Co/.test(bodyText) || bodyText.includes('Real Article'), 'site-header leaked into bodyText');
    assert.ok(bodyText.includes('Real Article'));
    assert.equal(mainContentSelector, 'article');
  });

  test('prefers a real content container (main/article) over sibling boilerplate', () => {
    const html = `<html><head><title>T</title></head><body>${NAV}` +
      `<main><h1>Main Heading</h1><p>${REAL_PARAGRAPH}</p></main>${FOOTER}</body></html>`;
    const { bodyText, mainContentSelector, wordCount } = analyzePage(html, 'https://example.com/page');
    assert.equal(mainContentSelector, 'main');
    assert.ok(bodyText.includes('Main Heading'));
    assert.ok(wordCount >= MIN_GROUNDING_WORDS);
  });

  test('falls back to the stripped whole body (still boilerplate-free) when no content container matches', () => {
    const html = `<html><head><title>T</title></head><body>${NAV}` +
      `<div><p>${REAL_PARAGRAPH}</p></div>${FOOTER}</body></html>`;
    const { bodyText, mainContentSelector } = analyzePage(html, 'https://example.com/page');
    assert.equal(mainContentSelector, null);
    assert.ok(bodyText.includes('substantial paragraph'));
    assert.ok(!/Copyright|Home.*About.*Contact/.test(bodyText));
  });

  test('a genuinely nav/footer-only page (no real content anywhere) produces a thin bodyText, not boilerplate text', () => {
    const html = `<html><head><title>T</title></head><body>${NAV}${FOOTER}</body></html>`;
    const { bodyText, wordCount } = analyzePage(html, 'https://example.com/page');
    assert.ok(!/Home|Copyright/.test(bodyText));
    assert.ok(wordCount < MIN_GROUNDING_WORDS);
  });
});

describe('hasSufficientGroundingContent / requireGroundedContent', () => {
  test('false/throws below MIN_GROUNDING_WORDS', () => {
    assert.equal(hasSufficientGroundingContent({ wordCount: MIN_GROUNDING_WORDS - 1 }), false);
    assert.throws(() => requireGroundedContent({ wordCount: 5 }, { generatorId: 'schema' }), /not enough real page content/i);
  });

  test('true/does not throw at or above MIN_GROUNDING_WORDS', () => {
    assert.equal(hasSufficientGroundingContent({ wordCount: MIN_GROUNDING_WORDS }), true);
    assert.doesNotThrow(() => requireGroundedContent({ wordCount: MIN_GROUNDING_WORDS + 10 }, { generatorId: 'schema' }));
  });

  test('null/undefined analysis is treated as insufficient, not a crash', () => {
    assert.equal(hasSufficientGroundingContent(null), false);
    assert.throws(() => requireGroundedContent(null, { generatorId: 'faq' }));
  });
});

describe('analyzePage — duplicate/invalid structured data (Phase 3 technical checks)', () => {
  const PAGE_URL = 'https://example.com/product';

  test('two independent blocks of the same @type are flagged as duplicates', () => {
    const html = `<html><body>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"A"}</script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"B"}</script>
    </body></html>`;
    const a = analyzePage(html, PAGE_URL);
    assert.deepEqual(a.duplicateSchemaTypes, ['Product']);
  });

  test('two different @types are not flagged as duplicates', () => {
    const html = `<html><body>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"A"}</script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"B"}</script>
    </body></html>`;
    const a = analyzePage(html, PAGE_URL);
    assert.deepEqual(a.duplicateSchemaTypes, []);
  });

  test('malformed JSON-LD is counted, not thrown, and does not poison other blocks', () => {
    const html = `<html><body>
      <script type="application/ld+json">{ not valid json </script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Real"}</script>
    </body></html>`;
    const a = analyzePage(html, PAGE_URL);
    assert.equal(a.malformedJsonLdBlocks, 1);
    assert.ok(a.schemaTypes.includes('Organization'));
  });
});

describe('analyzePage — imagesMissingAlt (alt-text.js grounding)', () => {
  const PAGE_URL = 'https://example.com/gallery';

  test('images with real alt text are excluded', () => {
    const html = '<html><body><img src="/a.jpg" alt="A real description"></body></html>';
    assert.deepEqual(analyzePage(html, PAGE_URL).imagesMissingAlt, []);
  });

  test('an image missing alt captures its src and nearest heading as context', () => {
    const html = '<html><body><h2>Product Gallery</h2><img src="/shoe.jpg"></body></html>';
    const images = analyzePage(html, PAGE_URL).imagesMissingAlt;
    assert.equal(images.length, 1);
    assert.equal(images[0].src, '/shoe.jpg');
    assert.equal(images[0].nearbyText, 'Product Gallery');
  });

  test('a figcaption takes priority over a page heading', () => {
    const html = '<html><body><h2>Gallery</h2><figure><img src="/x.jpg"><figcaption>Real caption text</figcaption></figure></body></html>';
    const images = analyzePage(html, PAGE_URL).imagesMissingAlt;
    assert.equal(images[0].nearbyText, 'Real caption text');
  });

  // Regression: a lazy-loaded/srcset-only <img> with no src/data-src still
  // has a real, patchable originalTag — dropping it here (on missing src)
  // used to make alt-text.js's generator see 0 images while the "Missing
  // alt text" finding it was drafting for still said N/M, a guaranteed-to-
  // fail recommendation shown as SAFE — AUTO-ELIGIBLE. src is only a
  // best-effort filename hint for the LLM prompt, not the patch anchor.
  test('an image with no extractable src is still included (originalTag is the real anchor)', () => {
    const html = '<html><body><img srcset="/a-2x.jpg 2x, /a-3x.jpg 3x" data-lazy="/a.jpg"></body></html>';
    const images = analyzePage(html, PAGE_URL).imagesMissingAlt;
    assert.equal(images.length, 1);
    assert.equal(images[0].src, '');
    assert.ok(images[0].originalTag.includes('srcset='));
  });
});

// Regression coverage: page-content.js used to only COUNT malformed JSON-LD
// blocks (malformedJsonLdBlocks) and detect duplicate @types
// (duplicateSchemaTypes) with no generator able to act on either — the real
// raw text captured here (malformedSchemaBlocks/schemaScriptBlocks) is what
// generators/schema-repair.js needs to both feed an LLM correction and
// later find verbatim in the site's real source to patch.
describe('analyzePage — structured-data repair signals', () => {
  const PAGE_URL = 'https://example.com/blog/post';

  test('a malformed JSON-LD block is counted and its raw text captured', () => {
    const html = '<html><head><script type="application/ld+json">{"@type": "Article", headline: "missing quotes"}</script></head><body></body></html>';
    const a = analyzePage(html, PAGE_URL);
    assert.equal(a.malformedJsonLdBlocks, 1);
    assert.equal(a.malformedSchemaBlocks.length, 1);
    assert.match(a.malformedSchemaBlocks[0], /missing quotes/);
  });

  test('schemaScriptBlocks captures one entry per real script tag, in document order, with its real types', () => {
    const html = '<html><head>'
      + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"First"}</script>'
      + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Second"}</script>'
      + '</head><body></body></html>';
    const a = analyzePage(html, PAGE_URL);
    assert.equal(a.schemaScriptBlocks.length, 2);
    assert.deepEqual(a.schemaScriptBlocks[0].types, ['Article']);
    assert.match(a.schemaScriptBlocks[1].raw, /"headline":"Second"/);
    assert.deepEqual(a.duplicateSchemaTypes, ['Article']);
  });

  test('no false positives on a page with clean, non-duplicate schema', () => {
    const html = '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Real"}</script></head><body></body></html>';
    const a = analyzePage(html, PAGE_URL);
    assert.equal(a.malformedJsonLdBlocks, 0);
    assert.deepEqual(a.malformedSchemaBlocks, []);
    assert.deepEqual(a.duplicateSchemaTypes, []);
  });
});

// Regression coverage for the wrong-@type bug: inferSchemaType used to end in
// `return 'Article'`, so every page that didn't match one of five hardcoded
// ENGLISH path words got an Article recommendation — and since the `schema`
// generator is SAFE-tier (agents/lib/risk-tiers.js) and generators/schema.js
// only validates field VALUES, that wrong @type could reach a tenant's live
// site unattended. Abstaining (null) is the only correct answer when the
// page's own evidence doesn't support a type.
describe('inferSchemaType', () => {
  test('abstains rather than guessing Article for a page with no type evidence', () => {
    assert.equal(inferSchemaType('https://example.com/pricing', []), null);
    assert.equal(inferSchemaType('https://example.com/services/booking', []), null);
    assert.equal(inferSchemaType('https://example.com/team', []), null);
  });

  test('abstains on a non-English site, where no path hint can ever match', () => {
    // The exact case the English regexes silently mistyped as Article for
    // every page on the site.
    assert.equal(inferSchemaType('https://example.de/produkte/wanderstiefel', []), null);
    assert.equal(inferSchemaType('https://example.fr/a-propos', []), null);
    assert.equal(inferSchemaType('https://example.jp/よくある質問', []), null);
  });

  test('abstains on an unparseable URL instead of falling back to a default', () => {
    assert.equal(inferSchemaType('not a url', []), null);
  });

  test('a real non-boilerplate @type already on the page wins over everything else', () => {
    assert.equal(inferSchemaType('https://example.com/blog/post', ['Course']), 'Course');
    // Site-wide boilerplate says nothing about THIS page, so it is skipped.
    assert.equal(inferSchemaType('https://example.com/pricing', ['Organization', 'WebSite']), null);
  });

  test('og:type is real page-declared evidence and works with no English in the URL', () => {
    assert.equal(inferSchemaType('https://example.de/beitrag/xyz', [], { openGraphType: 'article' }), 'Article');
    assert.equal(inferSchemaType('https://example.de/xyz', [], { openGraphType: 'product' }), 'Product');
    // 'website' is the near-universal default and says nothing page-specific.
    assert.equal(inferSchemaType('https://example.de/xyz', [], { openGraphType: 'website' }), null);
  });

  test('still returns the types it can honestly derive', () => {
    assert.equal(inferSchemaType('https://example.com/', []), 'Organization');
    assert.equal(inferSchemaType('https://example.com/products/hat', []), 'Product');
    assert.equal(inferSchemaType('https://example.com/faq', []), 'FAQPage');
    assert.equal(inferSchemaType('https://example.com/blog/post', []), 'Article');
  });
});

describe('analyzePage openGraphType', () => {
  test('captures the page\'s own og:type declaration, null when absent', () => {
    const withOg = '<html><head><meta property="og:type" content="product"></head><body></body></html>';
    assert.equal(analyzePage(withOg, 'https://example.com/x').openGraphType, 'product');
    assert.equal(analyzePage('<html><head></head><body></body></html>', 'https://example.com/x').openGraphType, null);
  });
});
