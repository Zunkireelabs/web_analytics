import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureMarkers, spliceMarkers, isHeadScopedField, isNoEofInsertField, buildMergeValues, findMarkerCorruption, renderExpandedHtml } from './marker-merge.js';

// Regression coverage for the zunkireelabs-web PR #87 incident: two
// independent title drafts (one landed on main, one on the batch branch)
// each cleanly replaced the same LINE marker's line in place — no single
// commit ever produced a duplicate. It was git's own "clean" merge of the
// two, sync'd by getOrInitBatchBranch (github-ops.js), that left both
// `title:` lines behind as invalid YAML. findMarkerCorruption is the
// content-level check that catches that outcome after the fact.
describe('findMarkerCorruption', () => {
  test('finds nothing wrong in a normal, single-occurrence LINE marker', () => {
    const content = '---\nlayout: base.njk\ntitle: "Hello" # SEOAI:TITLE\n---\n';
    assert.deepEqual(findMarkerCorruption(content), []);
  });

  test('flags a duplicated LINE marker, the actual PR #87 shape', () => {
    const content = [
      '---',
      'layout: base.njk',
      'title: "AI Search Playbook for Product Teams | Zunkiree Labs" # SEOAI:TITLE',
      'title: "Zunkiree Labs: AI Search Playbook for Product Teams" # SEOAI:TITLE',
      'description: x',
      '---',
    ].join('\n');
    assert.deepEqual(findMarkerCorruption(content), ['TITLE']);
  });

  test('finds nothing wrong in a normal, balanced BLOCK marker', () => {
    const content = '<!-- SEOAI:FAQ:START -->hi<!-- SEOAI:FAQ:END -->';
    assert.deepEqual(findMarkerCorruption(content), []);
  });

  test('flags a BLOCK marker with two START tags (or any start/end mismatch)', () => {
    const content = '<!-- SEOAI:FAQ:START -->a<!-- SEOAI:FAQ:START -->b<!-- SEOAI:FAQ:END -->';
    assert.deepEqual(findMarkerCorruption(content), ['FAQ']);
  });

  test('a file with several distinct, healthy markers stays clean', () => {
    const content = [
      'title: "T" # SEOAI:TITLE',
      '<!-- SEOAI:FAQ:START -->x<!-- SEOAI:FAQ:END -->',
      '{/* SEOAI:SCHEMA:START */}y{/* SEOAI:SCHEMA:END */}',
    ].join('\n');
    assert.deepEqual(findMarkerCorruption(content), []);
  });
});

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

  // Regression for the production incident (zunkireelabs.com/locations/
  // kathmandu/, PR #64 on zunkireelabs-web): generators/expand-content.js's
  // comparison-content focus asks the LLM for "a comparison table
  // structure" and reliably gets back GFM pipe-table syntax. Before this
  // fix, none of markdownToHtml's branches recognized a table row, so the
  // whole table (including its `|---|---|` separator) shipped as one long
  // <p> of literal pipes and dashes straight to a live page.
  test('expand-content renders a GFM pipe-table as a real <table>, never leaking literal pipes/dashes as visible text', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{
        heading: 'Comparison Table',
        body: '| Feature | Zunkiree Labs | Generic AI Provider |\n'
          + '|---------|---------------|----------------------|\n'
          + '| Location | Kathmandu, Nepal | Global (various locations) |\n'
          + '| Competitive Rates | Yes | Varies, often higher |',
      }],
    });
    assert.equal(result.ok, true);
    const html = result.values.expandedContent;
    assert.doesNotMatch(html, /\|-{2,}/, 'a raw separator row must never leak as visible text');
    assert.doesNotMatch(html, /<p>[^<]*\|/, 'a raw pipe-delimited row must never leak inside a paragraph');
    assert.match(html, /<table><thead><tr><th>Feature<\/th><th>Zunkiree Labs<\/th><th>Generic AI Provider<\/th><\/tr><\/thead>/);
    assert.match(html, /<tbody>.*<tr><td>Location<\/td><td>Kathmandu, Nepal<\/td><td>Global \(various locations\)<\/td><\/tr>/s);
    assert.match(html, /<tr><td>Competitive Rates<\/td><td>Yes<\/td><td>Varies, often higher<\/td><\/tr><\/tbody><\/table>/);
  });

  test('expand-content keeps prose before and after a table as separate paragraphs, table never nested inside a <p>', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{
        heading: 'Comparison',
        body: 'Here is how we compare.\n| A | B |\n|---|---|\n| 1 | 2 |\nThat concludes the comparison.',
      }],
    });
    assert.equal(result.ok, true);
    const html = result.values.expandedContent;
    assert.doesNotMatch(html, /<p>[^<]*<table>/, 'a <table> must never be nested inside a <p>');
    assert.match(html, /<p>Here is how we compare\.<\/p>/);
    assert.match(html, /<table>.*<\/table>/s);
    assert.match(html, /<p>That concludes the comparison\.<\/p>/);
  });

  // Regression for the production incident (zunkireelabs.com/locations/, PR
  // #64 on zunkireelabs-web): expand-content's comparison-content prompt
  // doesn't dictate a format, so the LLM sometimes writes literal HTML
  // instead of GFM markdown. Escaped like any other body text, that real
  // <table> markup shipped as visible `&lt;table class=...&gt;` text on a
  // live page.
  test('expand-content passes a body that already opens with real HTML through verbatim, never escaped', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{
        heading: 'Comparison Table',
        body: "<table class='table-auto w-full'> <thead> <tr> <th class='px-4 py-2'>Feature</th><th class='px-4 py-2'>Zunkiree Labs</th> </tr> </thead> <tbody> <tr> <td class='border px-4 py-2'>Headquarters</td><td class='border px-4 py-2'>Kathmandu, Nepal</td> </tr> </tbody> </table>",
      }],
    });
    assert.equal(result.ok, true);
    const html = result.values.expandedContent;
    assert.doesNotMatch(html, /&lt;table/, 'real HTML must never come out HTML-entity-escaped');
    assert.match(html, /<table class='table-auto w-full'>/);
    assert.match(html, /<td class='border px-4 py-2'>Kathmandu, Nepal<\/td>/);
  });

  // generators/expand-content.js's structured "table" field (added
  // alongside the markdown/HTML fallbacks above): rendered with OUR OWN
  // markup, never model-authored classes, and column labels are derived
  // from the row keys rather than a fixed schema — this data's real column
  // names ("zunkiree_labs", "competitor") are exactly what generators/
  // expand-content.test.js's real production example produced unprompted.
  test('expand-content renders a structured "table" field as a real <table>, columns Title Cased from the row keys', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{
        heading: 'Service Comparison Table',
        body: 'Below is a comparison table outlining the key differences.',
        table: [
          { feature: 'Custom AI Solutions', competitor: 'No', zunkiree_labs: 'Yes' },
          { feature: 'Local Market Specialization', competitor: 'Limited', zunkiree_labs: 'Yes (eSewa and Khalti integration)' },
        ],
      }],
    });
    assert.equal(result.ok, true);
    const html = result.values.expandedContent;
    assert.match(html, /<p>Below is a comparison table outlining the key differences\.<\/p>/);
    assert.match(html, /<table><thead><tr><th>Feature<\/th><th>Competitor<\/th><th>Zunkiree Labs<\/th><\/tr><\/thead>/);
    assert.match(html, /<tr><td>Custom AI Solutions<\/td><td>No<\/td><td>Yes<\/td><\/tr>/);
    assert.match(html, /<td>Yes \(eSewa and Khalti integration\)<\/td><\/tr><\/tbody><\/table>/);
    assert.doesNotMatch(html, /<p>[^<]*<table>/, 'the table must never be nested inside the body <p>');
  });

  test('expand-content escapes structured table cell values, never trusts them as HTML', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{
        heading: 'Comparison',
        body: 'See below.',
        table: [
          { feature: '<script>alert(1)</script>', us: 'Yes' },
          { feature: 'Normal', us: 'No' },
        ],
      }],
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.expandedContent, /<script>/);
    assert.match(result.values.expandedContent, /&lt;script&gt;/);
  });

  test('expand-content with no table field renders body alone, no stray empty <table>', () => {
    const result = buildMergeValues('expand-content', {
      sections: [{ heading: 'Plain', body: 'Just prose, no table here.' }],
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.expandedContent, /<table>/);
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

// The reported symptom this covers: on site 1, /team/ and the blog posts
// rendered a bare <details> Q&A block while / and /resources/ rendered the
// site's real Alpine accordion, because the site had captured
// componentTemplates.faq but never a separate qaContent.
describe('buildMergeValues — qa-content borrows the site\'s own FAQ template', () => {
  const items = [
    { question: 'How do I get in touch?', answer: 'Email or call us.' },
    { question: 'What are your hours?', answer: '9-5 Nepal time.' },
  ];
  const accordion = {
    wrapper: '<section x-data="{ activeIndex: null }">\n{{ROWS}}\n</section>',
    row: '<button @click="activeIndex = {{INDEX}}"><h3>{{QUESTION}}</h3></button><p>{{ANSWER}}</p>',
  };

  test('uses the captured faq accordion when the site has no qaContent template', () => {
    const result = buildMergeValues('qa-content', { items }, 'visible', { faq: accordion });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.values.qaContent, /<details>/);
    assert.match(result.values.qaContent, /<h3>How do I get in touch\?<\/h3>/);
    assert.match(result.values.qaContent, /activeIndex = 2/);
  });

  test('a captured qaContent template still wins outright', () => {
    const qaOwn = { wrapper: '<div class="qa">{{ROWS}}</div>', row: '<h2>{{QUESTION}}</h2><p>{{ANSWER}}</p>' };
    const result = buildMergeValues('qa-content', { items }, 'visible', { faq: accordion, qaContent: qaOwn });
    assert.equal(result.ok, true);
    assert.match(result.values.qaContent, /<div class="qa">/);
    assert.doesNotMatch(result.values.qaContent, /activeIndex/);
  });

  // Borrowing this one would look right and silently defeat the
  // questionHeadingCount check qa-content exists to satisfy.
  test('refuses to borrow a <dt>-based faq template, keeping the <details> default', () => {
    const dlTemplate = { wrapper: '<dl>{{ROWS}}</dl>', row: '<dt>{{QUESTION}}</dt><dd>{{ANSWER}}</dd>' };
    const result = buildMergeValues('qa-content', { items }, 'visible', { faq: dlTemplate });
    assert.equal(result.ok, true);
    assert.match(result.values.qaContent, /<details>/);
    assert.match(result.values.qaContent, /<h3>How do I get in touch\?<\/h3>/);
  });

  test('a site with no templates at all is unchanged — still the <details> default', () => {
    const result = buildMergeValues('qa-content', { items }, 'visible', {});
    assert.equal(result.ok, true);
    assert.match(result.values.qaContent, /<div class="qa-content">/);
    assert.match(result.values.qaContent, /<details>/);
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

// Regression coverage for a real design-breakdown that shipped autonomously:
// renderExpandedHtml already received the site's own captured table styling
// and passed it to renderComparisonTable (the STRUCTURED table path), but
// never to markdownToHtml — so the same comparison content, written by the
// model as MARKDOWN instead (which its own prompt invites), rendered as a
// bare class-less <table>. On a Tailwind site that is a visibly foreign
// block sitting beside a correctly-styled one on the same page.
describe('renderExpandedHtml — a markdown table gets the site\'s own table styling', () => {
  const STYLE = {
    wrapper: 'overflow-x-auto', table: 'w-full acme-table', thead: 'acme-head',
    tbody: 'acme-body', th: 'acme-th', td: 'acme-td', tdFirst: 'acme-td-first',
  };
  const SECTIONS = [{
    heading: 'Comparison',
    body: 'Here is a breakdown:\n\n| Feature | Ours | Theirs |\n| --- | --- | --- |\n| Speed | Fast | Slow |\n| Cost | Low | High |',
  }];

  test('applies the tenant\'s real captured classes, the same ones a structured table gets', () => {
    const html = renderExpandedHtml(SECTIONS, undefined, STYLE);
    assert.match(html, /<table class="w-full acme-table">/);
    assert.match(html, /<th class="acme-th">Feature<\/th>/);
    assert.match(html, /<td class="acme-td-first">Speed<\/td>/, 'the row-label column uses the site\'s own first-cell class');
    assert.match(html, /<td class="acme-td">Fast<\/td>/);
    assert.match(html, /<div class="overflow-x-auto">/);
    assert.doesNotMatch(html, /\| --- \|/, 'no raw markdown table syntax survives into the page');
  });

  test('a site with no captured table still renders a real, bare table (never another tenant\'s look)', () => {
    const html = renderExpandedHtml(SECTIONS, undefined, {});
    assert.match(html, /<table><thead><tr><th>Feature<\/th>/);
    assert.doesNotMatch(html, /acme/);
  });

  test('a table collapsed onto ONE line still renders as a real table, not literal pipes', () => {
    // The rows arrive joined by spaces with no newlines at all, so the
    // line-based detection has no next line to test for a separator row.
    const collapsed = [{
      heading: 'Comparison',
      body: 'Here is a breakdown: | Feature | Ours | Theirs | |---|---|---| | Speed | Fast | Slow | | Cost | Low | High |',
    }];
    const html = renderExpandedHtml(collapsed, undefined, STYLE);
    assert.match(html, /<table class="w-full acme-table">/);
    assert.match(html, /<th class="acme-th">Feature<\/th>/);
    assert.match(html, /<td class="acme-td">Fast<\/td>/);
    assert.doesNotMatch(html, /\|---\|/, 'no raw separator syntax survives');
    assert.match(html, /Here is a breakdown:/, 'the real lead-in sentence is preserved');
  });

  test('a normal row with an empty middle cell is NOT mistaken for collapsed rows', () => {
    // "| A |  | C |" also has two pipes separated only by spaces; without the
    // separator-run guard this would be split into bogus rows.
    const withEmptyCell = [{
      heading: 'Comparison',
      body: '| Feature | Ours | Theirs |\n| --- | --- | --- |\n| Speed |  | Slow |',
    }];
    const html = renderExpandedHtml(withEmptyCell, undefined, STYLE);
    assert.match(html, /<td class="acme-td-first">Speed<\/td><td class="acme-td"><\/td><td class="acme-td">Slow<\/td>/);
  });
});
