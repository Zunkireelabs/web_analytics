import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureMarkers, spliceMarkers, isHeadScopedField, isNoEofInsertField, buildMergeValues } from './marker-merge.js';

describe('head-scoped fields (canonical, open-graph)', () => {
  test('isHeadScopedField identifies the right fields', () => {
    assert.equal(isHeadScopedField('canonical'), true);
    assert.equal(isHeadScopedField('openGraph'), true);
    assert.equal(isHeadScopedField('analyticsScript'), true);
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

describe('body-scoped fields (expand-content)', () => {
  test('isNoEofInsertField identifies expandedContent and qaContent only', () => {
    assert.equal(isNoEofInsertField('expandedContent'), true);
    assert.equal(isNoEofInsertField('qaContent'), true);
    assert.equal(isNoEofInsertField('faq'), false);
    assert.equal(isNoEofInsertField('canonical'), false);
  });

  // Regression test: a component-based page (.jsx/.tsx/.astro) has real
  // markup after its last source line that is outside the rendered
  // component tree entirely. Before this guard, ensureMarkers would append
  // an empty EXPANDEDCONTENT marker at EOF, spliceMarkers would "succeed",
  // the PR would merge — and the new sections would never actually render
  // on the live page.
  test('ensureMarkers does NOT fall back to EOF insert for expandedContent', () => {
    const file = 'export default function Page() {\n  return <div>existing content</div>;\n}\n';
    const { content, inserted } = ensureMarkers(file, { expandedContent: 'EXPANDEDCONTENT' });
    assert.deepEqual(inserted, []);
    assert.equal(content, file); // untouched
    assert.doesNotMatch(content, /SEOAI:EXPANDEDCONTENT/);
  });

  test('spliceMarkers honestly fails when no human-placed expandedContent marker exists', () => {
    const file = 'export default function Page() {\n  return <div>existing content</div>;\n}\n';
    const markerMap = { expandedContent: 'EXPANDEDCONTENT' };
    const { content: ensured } = ensureMarkers(file, markerMap);
    const spliced = spliceMarkers(ensured, markerMap, { expandedContent: '<h2>New section</h2>' });
    assert.equal(spliced.ok, false);
    assert.deepEqual(spliced.missingMarkers, ['EXPANDEDCONTENT']);
  });

  test('full round trip: human-placed marker inside real body -> splice succeeds', () => {
    const file = 'export default function Page() {\n  return <div>existing content\n<!-- SEOAI:EXPANDEDCONTENT:START --><!-- SEOAI:EXPANDEDCONTENT:END -->\n</div>;\n}\n';
    const markerMap = { expandedContent: 'EXPANDEDCONTENT' };
    const { content: ensured } = ensureMarkers(file, markerMap);
    const spliced = spliceMarkers(ensured, markerMap, { expandedContent: '<h2>New section</h2>' });
    assert.equal(spliced.ok, true);
    assert.match(spliced.newContent, /<h2>New section<\/h2>/);
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

  test('open-graph blocks publishing when the placeholder (no real title/description found) is unresolved', () => {
    const result = buildMergeValues('open-graph', {
      ogTitle: '[NEEDS INPUT — not verifiable from real site data]',
      ogDescription: 'Real desc',
      placeholderFields: ['ogTitle'],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /ogTitle/);
  });

  test('analytics-install produces the real script verbatim once a real tracking ID is resolved', () => {
    const result = buildMergeValues('analytics-install', {
      script: '<script>gtag("config", "G-REAL123");</script>',
      placeholderFields: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.values.analyticsScript, '<script>gtag("config", "G-REAL123");</script>');
  });

  test('analytics-install blocks publishing when the real tracking ID is still a placeholder', () => {
    const result = buildMergeValues('analytics-install', {
      script: '<!-- placeholder -->',
      placeholderFields: ['trackingId'],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /trackingId/);
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

  test('expand-content never publishes a dead "#" link — downgrades it to plain text', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{ heading: 'H1', body: 'See [Authoritative Source](#) for details.' }],
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.expandedContent, /href="#"/);
    assert.match(result.values.expandedContent, /<p>See Authoritative Source for details\.<\/p>/);
  });

  test('expand-content renders a real http(s) link as a clickable anchor, and bold as <strong>', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{ heading: 'H1', body: 'Per [OpenAI docs](https://openai.com/docs), this is **important**.' }],
    });
    assert.equal(result.ok, true);
    assert.match(result.values.expandedContent, /<a href="https:\/\/openai\.com\/docs">OpenAI docs<\/a>/);
    assert.match(result.values.expandedContent, /<strong>important<\/strong>/);
  });


  test('qa-content falls back to a native <details>/<summary> with a real <h3> question — no site-specific CSS required to look correct', () => {
    const result = buildMergeValues('qa-content', {
      items: [{ question: 'What is this?', answer: 'A real answer.' }],
    });
    assert.equal(result.ok, true);
    assert.match(result.values.qaContent, /<summary><h3>What is this\?<\/h3><\/summary>/);
    assert.match(result.values.qaContent, /<p>A real answer\.<\/p>/);
  });

  test('qa-content uses the site\'s own configured qaContent template when given one, not the fallback', () => {
    const componentTemplates = {
      qaContent: {
        wrapper: '<section class="site-qa">\n{{ROWS}}\n</section>',
        row: '<h3 class="site-question">{{QUESTION}}</h3><p class="site-answer">{{ANSWER}}</p>',
      },
    };
    const result = buildMergeValues('qa-content', {
      items: [{ question: 'What is this?', answer: 'A real answer.' }],
    }, 'visible', componentTemplates);
    assert.equal(result.ok, true);
    assert.match(result.values.qaContent, /<h3 class="site-question">What is this\?<\/h3>/);
    assert.doesNotMatch(result.values.qaContent, /<details>/);
  });

  test('qa-content escapes untrusted question/answer text', () => {
    const result = buildMergeValues('qa-content', {
      items: [{ question: '<script>x</script>?', answer: '<script>y</script>' }],
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.qaContent, /<script>/);
  });

  test('qa-content fails honestly with no items', () => {
    const result = buildMergeValues('qa-content', { items: [] });
    assert.equal(result.ok, false);
  });

  test('qa-content has no schema-only representation', () => {
    const result = buildMergeValues('qa-content', {
      items: [{ question: 'What is this?', answer: 'A real answer.' }],
    }, 'schema-only');
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
