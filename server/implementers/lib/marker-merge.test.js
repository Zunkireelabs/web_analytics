import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureMarkers, spliceMarkers, isHeadScopedField, buildMergeValues } from './marker-merge.js';

describe('head-scoped fields (canonical, open-graph)', () => {
  test('isHeadScopedField identifies the right fields', () => {
    assert.equal(isHeadScopedField('canonical'), true);
    assert.equal(isHeadScopedField('openGraph'), true);
    assert.equal(isHeadScopedField('faq'), false);
    assert.equal(isHeadScopedField('title'), false);
  });

  test('ensureMarkers auto-creates a head-scoped field marker nested inside an existing HEAD region', () => {
    const file = '<head>\n<!-- SEOAI:HEAD:START --><!-- SEOAI:HEAD:END -->\n</head>';
    const { content, inserted } = ensureMarkers(file, { canonical: 'CANONICAL' });
    assert.deepEqual(inserted, ['CANONICAL']);
    assert.match(content, /<!-- SEOAI:HEAD:START -->[\s\S]*<!-- SEOAI:CANONICAL:START --><!-- SEOAI:CANONICAL:END -->[\s\S]*<!-- SEOAI:HEAD:END -->/);
  });

  test('ensureMarkers does NOT fall back to EOF insert when the HEAD region is absent', () => {
    const file = '<html><body>no head marker here</body></html>';
    const { content, inserted } = ensureMarkers(file, { canonical: 'CANONICAL' });
    assert.deepEqual(inserted, []);
    assert.equal(content, file); // untouched
    assert.doesNotMatch(content, /SEOAI:CANONICAL/);
  });

  test('spliceMarkers honestly fails when a head-scoped marker was never created (no HEAD region)', () => {
    const file = '<html><body>no head marker here</body></html>';
    const markerMap = { canonical: 'CANONICAL' };
    const { content: ensured } = ensureMarkers(file, markerMap);
    const spliced = spliceMarkers(ensured, markerMap, { canonical: '<link rel="canonical" href="https://example.com/">' });
    assert.equal(spliced.ok, false);
    assert.deepEqual(spliced.missingMarkers, ['CANONICAL']);
  });

  test('full round trip: HEAD region present -> auto-create -> splice succeeds', () => {
    const file = '<head>\n<!-- SEOAI:HEAD:START --><!-- SEOAI:HEAD:END -->\n</head>';
    const markerMap = { canonical: 'CANONICAL' };
    const { content: ensured } = ensureMarkers(file, markerMap);
    const spliced = spliceMarkers(ensured, markerMap, { canonical: '<link rel="canonical" href="https://example.com/">' });
    assert.equal(spliced.ok, true);
    assert.match(spliced.newContent, /<link rel="canonical" href="https:\/\/example\.com\/">/);
  });

  test('a normal BLOCK field (faq) is unaffected — still auto-inserts at EOF', () => {
    const file = 'plain body content';
    const { content, inserted } = ensureMarkers(file, { faq: 'FAQ' });
    assert.deepEqual(inserted, ['FAQ']);
    assert.match(content, /<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->/);
  });
});

describe('buildMergeValues — canonical/open-graph/expand-content', () => {
  test('canonical produces a single link tag', () => {
    const result = buildMergeValues('canonical', { canonicalUrl: 'https://example.com/page' });
    assert.equal(result.ok, true);
    assert.equal(result.values.canonical, '<link rel="canonical" href="https://example.com/page">');
  });

  test('canonical fails honestly with no URL', () => {
    const result = buildMergeValues('canonical', {});
    assert.equal(result.ok, false);
  });

  test('open-graph produces title + description meta tags', () => {
    const result = buildMergeValues('open-graph', { ogTitle: 'Title', ogDescription: 'Desc' });
    assert.equal(result.ok, true);
    assert.match(result.values.openGraph, /og:title" content="Title"/);
    assert.match(result.values.openGraph, /og:description" content="Desc"/);
  });

  test('open-graph escapes untrusted content', () => {
    const result = buildMergeValues('open-graph', { ogTitle: '<script>x</script>', ogDescription: '' });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.openGraph, /<script>/);
  });

  test('expand-content falls back to plain, zero-CSS-assumption tags when the site has no configured template', () => {
    const result = buildMergeValues('expand-content', { sections: [{ heading: 'H1', body: 'Body text' }] });
    assert.equal(result.ok, true);
    assert.match(result.values.expandedContent, /<h2>H1<\/h2>/);
    assert.match(result.values.expandedContent, /<p>Body text<\/p>/);
  });

  test('expand-content uses the site\'s own configured template when given one, not the fallback', () => {
    const componentTemplates = {
      expandContent: {
        wrapper: '<section>\n{{ROWS}}\n</section>',
        row: '<h3 class="site-heading">{{HEADING}}</h3><p class="site-body">{{BODY}}</p>',
      },
    };
    const result = buildMergeValues('expand-content', { sections: [{ heading: 'H1', body: 'Body text' }] }, 'visible', componentTemplates);
    assert.equal(result.ok, true);
    assert.match(result.values.expandedContent, /<h3 class="site-heading">H1<\/h3>/);
    assert.doesNotMatch(result.values.expandedContent, /<h2>/);
  });

  test('expand-content fails honestly with no sections', () => {
    const result = buildMergeValues('expand-content', { sections: [] });
    assert.equal(result.ok, false);
  });

  test('internal-links falls back to a bare, unstyled <ul> when the site has no configured template', () => {
    const result = buildMergeValues('internal-links', {
      suggestions: [{ targetUrl: '/products/search/', anchorText: 'Zunkiree Search' }],
    });
    assert.equal(result.ok, true);
    assert.match(result.values.links, /<ul class="related-links">/);
    assert.match(result.values.links, /<a href="\/products\/search\/">Zunkiree Search<\/a>/);
  });

  test('internal-links uses the site\'s own configured template when given one, not the fallback', () => {
    const componentTemplates = {
      internalLinks: {
        wrapper: '<nav class="related">\n{{ROWS}}\n</nav>',
        row: '<a class="site-link" href="{{URL}}">{{ANCHOR_TEXT}}</a>',
      },
    };
    const result = buildMergeValues('internal-links', {
      suggestions: [{ targetUrl: '/products/search/', anchorText: 'Zunkiree Search' }],
    }, 'visible', componentTemplates);
    assert.equal(result.ok, true);
    assert.match(result.values.links, /<a class="site-link" href="\/products\/search\/">Zunkiree Search<\/a>/);
    assert.doesNotMatch(result.values.links, /<ul class="related-links">/);
  });

  test('internal-links escapes untrusted anchor text/URLs', () => {
    const result = buildMergeValues('internal-links', {
      suggestions: [{ targetUrl: '"><script>x</script>', anchorText: '<script>y</script>' }],
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.links, /<script>/);
  });

  test('internal-links fails honestly with no suggestions', () => {
    const result = buildMergeValues('internal-links', { suggestions: [] });
    assert.equal(result.ok, false);
  });
});

describe('buildMergeValues — faq (per-site template, not one tenant\'s markup hardcoded for everyone)', () => {
  const items = [
    { question: 'How do I get in touch?', answer: 'Email or call us.' },
    { question: 'What are your hours?', answer: '9-5 Nepal time.' },
  ];

  test('falls back to a plain <dl>, zero site-specific CSS assumptions, when the site has no configured template', () => {
    const result = buildMergeValues('faq', { items });
    assert.equal(result.ok, true);
    assert.match(result.values.faq, /<dl class="faq">/);
    assert.match(result.values.faq, /<dt>How do I get in touch\?<\/dt>/);
    assert.match(result.values.faq, /<dd>Email or call us\.<\/dd>/);
  });

  test('uses the site\'s own configured accordion template when given one, not the fallback', () => {
    const componentTemplates = {
      faq: {
        wrapper: '<section x-data="{ activeIndex: null }">\n{{ROWS}}\n</section>',
        row: '<button @click="activeIndex = {{INDEX}}">{{QUESTION}}</button><p>{{ANSWER}}</p>',
      },
    };
    const result = buildMergeValues('faq', { items }, 'visible', componentTemplates);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.faq, /<dl class="faq">/);
    assert.match(result.values.faq, /<button @click="activeIndex = 1">How do I get in touch\?<\/button>/);
    assert.match(result.values.faq, /<button @click="activeIndex = 2">What are your hours\?<\/button>/);
  });

  test('escapes untrusted question/answer content', () => {
    const result = buildMergeValues('faq', { items: [{ question: '<script>x</script>', answer: 'ok' }] });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.faq, /<script>/);
  });

  test('still appends the JSON-LD schema after the visible block', () => {
    const schemaJsonLd = { '@type': 'FAQPage' };
    const result = buildMergeValues('faq', { items, schemaJsonLd });
    assert.match(result.values.faq, /<script type="application\/ld\+json">.*"@type":"FAQPage"/);
  });

  test('fails honestly with no items', () => {
    const result = buildMergeValues('faq', { items: [] });
    assert.equal(result.ok, false);
  });
});
