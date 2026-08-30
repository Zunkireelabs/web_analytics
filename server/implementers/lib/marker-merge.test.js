import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureMarkers, spliceMarkers, isHeadScopedField, isNoEofInsertField, buildMergeValues } from './marker-merge.js';

describe('head-scoped fields (canonical, open-graph)', () => {
  test('isHeadScopedField identifies the right fields', () => {
    assert.equal(isHeadScopedField('canonical'), true);
    assert.equal(isHeadScopedField('openGraph'), true);
    assert.equal(isHeadScopedField('analyticsScriptGa4'), true);
    assert.equal(isHeadScopedField('analyticsScriptFacebookPixel'), true);
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

  // Plain Markdown/MDX is the one shape where EOF really is inside the
  // rendered body (see isNoEofInsertField's comment) — every OTHER body
  // field, including faq, now needs real structural detection
  // (insertion-engine.js's resolveInsertion) rather than a blind EOF guess.
  test('a normal BLOCK field (faq) still auto-inserts at EOF on a plain Markdown file', () => {
    const file = '# Post\n\nplain body content';
    const { content, inserted } = ensureMarkers(file, { faq: 'FAQ' }, 'content/post.md');
    assert.deepEqual(inserted, ['FAQ']);
    assert.match(content, /<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->/);
  });

  test('a normal BLOCK field (faq) does NOT auto-insert at EOF on a non-Markdown file — real structural detection is required instead', () => {
    const file = 'plain body content';
    const { content, inserted } = ensureMarkers(file, { faq: 'FAQ' }, 'src/pages/about.astro');
    assert.deepEqual(inserted, []);
    assert.equal(content, file); // untouched
  });
});

describe('body-scoped fields (expand-content)', () => {
  test('isNoEofInsertField identifies every body-scoped BLOCK field, not just expandedContent/qaContent — LINE and HEAD-scoped fields are the only exceptions', () => {
    assert.equal(isNoEofInsertField('expandedContent'), true);
    assert.equal(isNoEofInsertField('qaContent'), true);
    assert.equal(isNoEofInsertField('faq'), true);
    assert.equal(isNoEofInsertField('schema'), true);
    assert.equal(isNoEofInsertField('links'), true);
    assert.equal(isNoEofInsertField('canonical'), false);
    assert.equal(isNoEofInsertField('title'), false);
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

  // A plain .md/.mdx content file has no component wrapper — the whole file
  // body IS the rendered article, so EOF is genuinely inside the render
  // tree here (unlike the .jsx regression case above). ensureMarkers should
  // auto-place the marker when given the file's path.
  test('ensureMarkers DOES fall back to EOF insert for expandedContent on a plain .md file', () => {
    const file = '---\ntitle: "Example"\n---\nSome article body.\n';
    const markerMap = { expandedContent: 'EXPANDEDCONTENT' };
    const { content, inserted } = ensureMarkers(file, markerMap, 'src/blog/example.md');
    assert.deepEqual(inserted, ['EXPANDEDCONTENT']);
    assert.match(content, /SEOAI:EXPANDEDCONTENT:START.*SEOAI:EXPANDEDCONTENT:END/s);

    const spliced = spliceMarkers(content, markerMap, { expandedContent: '<h2>New section</h2>' });
    assert.equal(spliced.ok, true);
    assert.match(spliced.newContent, /<h2>New section<\/h2>/);
  });

  test('ensureMarkers still does NOT fall back to EOF insert for expandedContent on a .jsx file even with a filePath given', () => {
    const file = 'export default function Page() {\n  return <div>existing content</div>;\n}\n';
    const markerMap = { expandedContent: 'EXPANDEDCONTENT' };
    const { content, inserted } = ensureMarkers(file, markerMap, 'src/pages/example.jsx');
    assert.deepEqual(inserted, []);
    assert.equal(content, file);
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

  test('open-graph also emits matching Twitter Card tags under the same field', () => {
    const result = buildMergeValues('open-graph', {
      ogTitle: 'Title', ogDescription: 'Desc', twitterCard: 'summary_large_image', twitterTitle: 'Title', twitterDescription: 'Desc',
    });
    assert.equal(result.ok, true);
    assert.match(result.values.openGraph, /twitter:card" content="summary_large_image"/);
    assert.match(result.values.openGraph, /twitter:title" content="Title"/);
    assert.match(result.values.openGraph, /twitter:description" content="Desc"/);
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

  test('analytics-install produces the real script verbatim once a real tracking ID is resolved, under its provider-specific field', () => {
    const result = buildMergeValues('analytics-install', {
      provider: 'ga4',
      script: '<script>gtag("config", "G-REAL123");</script>',
      placeholderFields: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.values.analyticsScriptGa4, '<script>gtag("config", "G-REAL123");</script>');
  });

  test('analytics-install uses a DIFFERENT field per provider, so a GA4 draft and a Facebook Pixel draft never target the same marker', () => {
    const ga4 = buildMergeValues('analytics-install', { provider: 'ga4', script: '<script>ga4</script>', placeholderFields: [] });
    const pixel = buildMergeValues('analytics-install', { provider: 'facebook-pixel', script: '<script>pixel</script>', placeholderFields: [] });
    assert.deepEqual(Object.keys(ga4.values), ['analyticsScriptGa4']);
    assert.deepEqual(Object.keys(pixel.values), ['analyticsScriptFacebookPixel']);
  });

  test('analytics-install blocks publishing when the real tracking ID is still a placeholder', () => {
    const result = buildMergeValues('analytics-install', {
      provider: 'ga4',
      script: '<!-- placeholder -->',
      placeholderFields: ['trackingId'],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /trackingId/);
  });

  test('analytics-install fails honestly for an unknown provider instead of silently picking a field', () => {
    const result = buildMergeValues('analytics-install', { provider: 'bing-ads', script: '<script>x</script>', placeholderFields: [] });
    assert.equal(result.ok, false);
    assert.match(result.error, /Unknown analytics-install provider/);
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

  test('expand-content renders a "- " bullet list (external-citations\' natural multi-source shape) as a real <ul><li>, never leaking literal "- " as visible text', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{
        heading: 'References',
        body: '- [Source One](https://example.com/one)\n- [Source Two](https://example.com/two)',
      }],
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.expandedContent, />-\s/);
    assert.match(
      result.values.expandedContent,
      /<ul><li><a href="https:\/\/example\.com\/one">Source One<\/a><\/li><li><a href="https:\/\/example\.com\/two">Source Two<\/a><\/li><\/ul>/,
    );
    // Regression: the row template used to wrap the whole body in a fixed
    // <p>...</p>, so a bullet-list-only body rendered as <p><ul>...</ul></p>
    // — block content nested inside a <p>, which is invalid HTML that
    // browsers recover from by force-closing the <p> early.
    assert.doesNotMatch(result.values.expandedContent, /<p>\s*<ul>/);
  });

  test('expand-content keeps prose and a bullet list as siblings, never a <ul> nested inside a <p>', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{
        heading: 'References',
        body: 'See the sources below.\n- [Source One](https://example.com/one)\n- [Source Two](https://example.com/two)\nMore context after the list.',
      }],
    });
    assert.equal(result.ok, true);
    const html = result.values.expandedContent;
    assert.doesNotMatch(html, /<p>[^<]*<ul>/, 'a <ul> must never be nested inside a <p> — invalid HTML that browsers force-close');
    assert.match(html, /<p>See the sources below\.<\/p>/);
    assert.match(html, /<ul><li>.*<\/li><\/ul>/s);
    assert.match(html, /<p>More context after the list\.<\/p>/, 'text after the list must survive as its own paragraph, not get silently dropped');
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

  // Regression: a page that already has a visible FAQ must be able to get
  // qa-content as structured data only, the same way 'faq' can — otherwise
  // render-inspector.js's cap/dedup deciding 'schema-only' for this
  // generator would have nothing it could actually publish, since the mode
  // decision and the content-building capability have to agree.
  test('qa-content schema-only mode publishes real JSON-LD, mirroring faq', () => {
    const schemaJsonLd = { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'What is this?' }] };
    const result = buildMergeValues('qa-content', {
      items: [{ question: 'What is this?', answer: 'A real answer.' }], schemaJsonLd,
    }, 'schema-only');
    assert.equal(result.ok, true);
    assert.match(result.values.qaContent, /<script type="application\/ld\+json">.*"@type":"FAQPage"/);
    assert.doesNotMatch(result.values.qaContent, /<details>/, 'schema-only must not also publish the visible accordion');
  });

  test('qa-content schema-only mode fails honestly with no schemaJsonLd to publish', () => {
    const result = buildMergeValues('qa-content', {
      items: [{ question: 'What is this?', answer: 'A real answer.' }],
    }, 'schema-only');
    assert.equal(result.ok, false);
  });

  test('qa-content still appends the JSON-LD schema after the visible block, mirroring faq', () => {
    const schemaJsonLd = { '@type': 'FAQPage' };
    const result = buildMergeValues('qa-content', {
      items: [{ question: 'What is this?', answer: 'A real answer.' }], schemaJsonLd,
    });
    assert.match(result.values.qaContent, /<script type="application\/ld\+json">.*"@type":"FAQPage"/);
  });

  test('qa-content suppressSchema omits the JSON-LD, avoiding a second FAQPage schema when faq already published one', () => {
    const schemaJsonLd = { '@type': 'FAQPage' };
    const result = buildMergeValues('qa-content', {
      items: [{ question: 'What is this?', answer: 'A real answer.' }], schemaJsonLd,
    }, 'visible', {}, null, { suppressSchema: true });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.qaContent, /application\/ld\+json/);
  });

  test('qa-content suppressSchema in schema-only mode fails honestly instead of publishing nothing silently', () => {
    const schemaJsonLd = { '@type': 'FAQPage' };
    const result = buildMergeValues('qa-content', {
      items: [{ question: 'What is this?', answer: 'A real answer.' }], schemaJsonLd,
    }, 'schema-only', {}, null, { suppressSchema: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /already has an FAQPage schema/);
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

// Regression coverage for a real bug: breadcrumbs.js (generators/) and
// risk-tiers.js both already treated 'breadcrumbs' as a real, safe-tier
// generator, but buildMergeValues had no case for it at all — every
// breadcrumbs draft would fail at apply time with "No merge strategy for
// action type." These pin the fix, including the field name: breadcrumbs
// must NOT share schema.js's 'schema' field, since a page can carry real
// Article/Product/etc. schema AND a BreadcrumbList at once, and
// spliceMarkers is a wholesale replace, not an append — sharing one field
// would mean whichever of the two generators applies second destroys the
// other's JSON-LD.
describe('buildMergeValues — breadcrumbs', () => {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' }],
  };

  test('produces a JSON-LD script tag under its own breadcrumbSchema field, not schema', () => {
    const result = buildMergeValues('breadcrumbs', { jsonLd });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.values), ['breadcrumbSchema']);
    assert.match(result.values.breadcrumbSchema, /<script type="application\/ld\+json">/);
    assert.match(result.values.breadcrumbSchema, /"@type":"BreadcrumbList"/);
  });

  test('fails honestly with no JSON-LD', () => {
    const result = buildMergeValues('breadcrumbs', {});
    assert.equal(result.ok, false);
  });

  test('has no schema-only representation (already schema-only by nature)', () => {
    const result = buildMergeValues('breadcrumbs', { jsonLd }, 'schema-only');
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

  test('suppressSchema omits the JSON-LD but keeps the visible block, avoiding a second FAQPage schema when qa-content already published one', () => {
    const schemaJsonLd = { '@type': 'FAQPage' };
    const result = buildMergeValues('faq', { items, schemaJsonLd }, 'visible', {}, null, { suppressSchema: true });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.faq, /application\/ld\+json/);
    assert.match(result.values.faq, /<dl class="faq">/);
  });

  test('suppressSchema in schema-only mode fails honestly instead of publishing nothing silently', () => {
    const schemaJsonLd = { '@type': 'FAQPage' };
    const result = buildMergeValues('faq', { items, schemaJsonLd }, 'schema-only', {}, null, { suppressSchema: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /already has an FAQPage schema/);
  });
});

describe('JSX marker convention (.jsx/.tsx bootstrap-created markers)', () => {
  // ensureMarkers itself no longer creates a body-scoped marker on a .tsx
  // file at all (see isNoEofInsertField above) — that's now
  // insertion-engine.js's job, via real structural detection, and it's the
  // one that uses the {/* */} JSX comment convention (see its own tests).
  test('ensureMarkers refuses a body-scoped marker on a .tsx file, leaving it for real structural detection', () => {
    const file = 'export default function Page() {\n  return <main>hi</main>;\n}\n';
    const { content, inserted } = ensureMarkers(file, { links: 'LINKS' }, 'src/pages/about.tsx');
    assert.deepEqual(inserted, []);
    assert.equal(content, file);
  });

  test('spliceMarkers wraps the value in dangerouslySetInnerHTML for a JSX marker, never splices raw HTML as JSX children', () => {
    const file = 'function Page() {\n  return (\n    <main>\n      {/* SEOAI:QACONTENT:START */}{/* SEOAI:QACONTENT:END */}\n    </main>\n  );\n}\n';
    const spliced = spliceMarkers(file, { qaContent: 'QACONTENT' }, { qaContent: '<div class="qa"><p>Q</p></div>' });
    assert.equal(spliced.ok, true);
    assert.match(spliced.newContent, /dangerouslySetInnerHTML=\{\{ __html: "<div class=\\"qa\\"><p>Q<\/p><\/div>" \}\}/);
    assert.doesNotMatch(spliced.newContent, /<main>\s*<div class="qa">/); // never a raw, invalid-JSX splice
  });

  test('a marker already present on a JSX file round-trips through ensureMarkers unchanged', () => {
    const file = 'function Page() {\n  return <main>{/* SEOAI:LINKS:START */}{/* SEOAI:LINKS:END */}</main>;\n}\n';
    const { content, inserted } = ensureMarkers(file, { links: 'LINKS' }, 'page.jsx');
    assert.deepEqual(inserted, []);
    assert.equal(content, file);
  });
});
