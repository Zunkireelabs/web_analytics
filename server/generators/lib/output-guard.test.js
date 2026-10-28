import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findEmptyWrappers, findJsonLdIssues, findContentIssues, findLinkSuggestionIssues,
  anchorOverlapsTarget, findMergeValueIssues, isEmptyMarkerValue, findRenderedIssues,
} from './output-guard.js';
import { buildMergeValues, spliceMarkers } from '../../implementers/lib/marker-merge.js';

const ids = (issues) => issues.map((i) => i.patternId);

describe('1. empty wrapper', () => {
  test('the blank bordered strip seen in 6 posts is rejected', () => {
    const bad = '<!-- SEOAI:FOCUS:general --><div class="mt-10 p-6 bg-gray-50 rounded-lg border border-gray-200"></div>';
    assert.deepEqual(ids(findEmptyWrappers(bad)), ['empty-wrapper']);
  });
  test('nested empties and whitespace/nbsp-only wrappers are rejected', () => {
    assert.deepEqual(ids(findEmptyWrappers('<section><div>\n &nbsp; </div></section>')), ['empty-wrapper']);
  });
  test('a wrapper with real text passes', () => {
    assert.deepEqual(findEmptyWrappers('<div class="mt-10 p-6 bg-gray-50"><h2>Why it matters</h2><p>Real prose.</p></div>'), []);
  });
});

describe('2. scraped-navigation / self-review schema', () => {
  const nav = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Review',
    reviewBody: 'Skip to main content Products Solutions GaaS Pricing About Contact',
    itemReviewed: { '@type': 'Article', name: 'How to build a RAG pipeline' },
  });
  test('menu text in reviewBody is rejected, and so is the self-review', () => {
    const found = ids(findJsonLdIssues(`<script type="application/ld+json">${nav}</script>`));
    assert.ok(found.includes('jsonld-scraped-navigation'));
    assert.ok(found.includes('jsonld-self-review'));
  });
  test('a run of menu labels with no sentence is caught without the literal phrase', () => {
    const blob = JSON.stringify({ '@type': 'Article', description: 'Home Products Solutions Pricing Blog Resources Careers Contact' });
    assert.ok(ids(findJsonLdIssues(`<script type="application/ld+json">${blob}</script>`)).includes('jsonld-scraped-navigation'));
  });
  test('invalid JSON-LD is rejected', () => {
    assert.deepEqual(ids(findJsonLdIssues('<script type="application/ld+json">{not json</script>')), ['jsonld-invalid']);
  });
  test('a real Article schema passes', () => {
    const ok = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: 'How to build a RAG pipeline', description: 'A walkthrough of retrieval, chunking and evaluation.' });
    assert.deepEqual(findJsonLdIssues(`<script type="application/ld+json">${ok}</script>`), []);
  });
});

describe('3. tables', () => {
  test('the filler "Competitors for…" table with an unnamed Alternative is rejected', () => {
    const issues = findContentIssues({ sections: [{
      heading: 'Competitors for document search',
      body: 'Compare the options.',
      table: [
        { feature: 'Document types', this_option: 'PDF, DOCX, HTML', alternative: 'Focus may be on specific document types' },
        { feature: 'Setup', this_option: 'Minutes', alternative: 'May require more configuration' },
      ],
    }] });
    const found = ids(issues);
    assert.ok(found.includes('table-unnamed-competitor'));
    assert.ok(found.includes('table-filler'));
    assert.ok(found.includes('competitor-profile-heading'));
  });
  test('empty header cell and all-empty row are rejected (structured, markdown and HTML)', () => {
    assert.ok(ids(findContentIssues({ sections: [{ heading: 'h', body: 'b', table: [{ a: 'x', '': 'y' }, { a: 'x', '': 'z' }] }] })).includes('table-empty-header'));
    assert.ok(ids(findContentIssues({ sections: [{ heading: 'h', body: 'b', table: [{ a: 'x', b: 'y' }, { a: '', b: '' }] }] })).includes('table-empty-row'));
    assert.ok(ids(findContentIssues({ sections: [{ heading: 'h', body: '| Tool |  |\n|---|---|\n| A | B |' }] })).includes('table-empty-header'));
    assert.ok(ids(findRenderedIssues('<table><tr><td>a</td><td>b</td></tr></table>')).includes('table-no-header'));
  });
  test('a grounded, named comparison passes', () => {
    assert.deepEqual(findContentIssues({ sections: [{
      heading: 'How the options differ', body: 'Three real trade-offs.',
      table: [{ feature: 'Hosting', pinecone: 'Managed only', pgvector: 'Self-hosted in Postgres' }, { feature: 'Scale', pinecone: 'Billions of vectors', pgvector: 'Millions of vectors' }],
    }] }), []);
  });
});

describe('4. internal-link anchors', () => {
  test('"strong English proficiency" → the Nepali-language AI guide is rejected', () => {
    const issues = findLinkSuggestionIssues([{ anchorText: 'strong English proficiency', targetUrl: 'https://z.com/blog/nepali-language-ai-guide', targetTitle: 'A guide to AI in the Nepali language' }]);
    assert.deepEqual(ids(issues), ['link-anchor-mismatch']);
  });
  test('"enterprise AI" → a case study with no overlap is rejected', () => {
    assert.deepEqual(ids(findLinkSuggestionIssues([{ anchorText: 'enterprise gateway', targetUrl: 'https://z.com/case-studies/chayce-leads', targetTitle: 'Chayce lead capture case study' }])), ['link-anchor-mismatch']);
  });
  test('an unresolvable target is rejected when a resolver is given', () => {
    const issues = findLinkSuggestionIssues([{ anchorText: 'RAG pipeline', targetUrl: 'https://z.com/how-to-build-rag-pipeline' }], { resolves: () => false });
    assert.deepEqual(ids(issues), ['link-target-unresolved']);
  });
  test('an anchor from the target title or slug passes', () => {
    assert.equal(anchorOverlapsTarget('build a RAG pipeline', 'https://z.com/how-to-build-rag-pipeline'), true);
    assert.deepEqual(findLinkSuggestionIssues([{ anchorText: 'AI guide for Nepali', targetUrl: 'https://z.com/blog/nepali-language-ai-guide', targetTitle: 'A guide to AI in the Nepali language' }], { resolves: () => true }), []);
  });
});

describe('5. empty markers', () => {
  test('empty, whitespace-only and empty JSON-LD values count as empty', () => {
    for (const v of ['', '   \n', '<script type="application/ld+json">{}</script>', null, { block: '', line: null }]) assert.equal(isEmptyMarkerValue(v), true);
    assert.equal(isEmptyMarkerValue('<p>x</p>'), false);
  });
  test('spliceMarkers leaves a marker untouched instead of writing it empty', () => {
    const file = 'a\n<!-- SEOAI:SCHEMA:START -->\nOLD\n<!-- SEOAI:SCHEMA:END -->\nb';
    const out = spliceMarkers(file, { schema: 'SCHEMA' }, { schema: '' });
    assert.equal(out.ok, true);
    assert.equal(out.newContent, file);
    assert.equal(out.changedRegions.length, 0);
  });
  test('findMergeValueIssues flags an empty value by field name', () => {
    assert.deepEqual(ids(findMergeValueIssues({ schema: '   ' })), ['marker-empty']);
  });
});

describe('buildMergeValues refuses bad drafts (hand-built and auto-built alike)', () => {
  test('expand-content whose render is an empty wrapper', () => {
    const r = buildMergeValues('expand-content', { sections: [{ heading: 'H', body: 'B' }] }, 'visible',
      { expandContent: { wrapper: '<div class="mt-10 p-6 bg-gray-50 rounded-lg">{{ROWS}}</div>', row: '' } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'output-guard');
    assert.match(r.error, /empty-wrapper/);
  });
  test('schema with scraped navigation', () => {
    const r = buildMergeValues('schema', { jsonLd: { '@type': 'Review', reviewBody: 'Skip to main content Products Solutions' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /jsonld/);
  });
  test('a clean draft still builds, and carries no internal fields', () => {
    const r = buildMergeValues('expand-content', { sections: [{ heading: 'Real heading', body: 'Real body text.' }] });
    assert.equal(r.ok, true);
    assert.equal('fresh' in r, false);
    const s = buildMergeValues('schema', { jsonLd: { '@context': 'https://schema.org', '@type': 'Article', headline: 'Real' } });
    assert.equal(s.ok, true);
  });
  test('internal-links: a mismatched anchor and an unresolved target are refused', () => {
    const bad = buildMergeValues('internal-links', { suggestions: [{ targetUrl: '/nepali-ai-guide', anchorText: 'strong English proficiency' }] });
    assert.equal(bad.ok, false);
    const unresolved = buildMergeValues('internal-links', { suggestions: [{ targetUrl: '/nepali-ai-guide', anchorText: 'Nepali AI guide' }] }, 'visible', {}, null, { resolveLinkTarget: () => false });
    assert.equal(unresolved.ok, false);
    const good = buildMergeValues('internal-links', { suggestions: [{ targetUrl: '/nepali-ai-guide', anchorText: 'Nepali AI guide' }] }, 'visible', {}, null, { resolveLinkTarget: () => true });
    assert.equal(good.ok, true);
  });
});

describe('false-positive protection', () => {
  test('a decorative empty element in a site template is not a blank strip', () => {
    assert.deepEqual(findEmptyWrappers('<div class="rounded-lg"><div class="h-1 w-12 bg-primary" aria-hidden="true"></div><h2>Real</h2><p>Text</p></div>'), []);
    assert.deepEqual(findEmptyWrappers('<div><div class="divider"></div><p>Text</p></div>'), []);
    assert.deepEqual(ids(findEmptyWrappers('<div class="mt-10 p-6 bg-gray-50 rounded-lg border"></div>')), ['empty-wrapper']);
  });
  test('a real review of a Product or business passes; a review of the article itself does not', () => {
    const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
    assert.deepEqual(findJsonLdIssues(ld({ '@type': 'Product', name: 'Widget', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '120' } })), []);
    assert.deepEqual(findJsonLdIssues(ld({ '@type': 'Review', itemReviewed: { '@type': 'LocalBusiness', name: 'Acme' }, reviewRating: { ratingValue: '5' }, author: { name: 'A' } })), []);
    assert.ok(ids(findJsonLdIssues(ld({ '@type': 'Article', headline: 'x', aggregateRating: { '@type': 'AggregateRating', ratingValue: '5', reviewCount: '9' } }))).includes('jsonld-self-review'));
    assert.ok(ids(findJsonLdIssues(ld({ '@type': 'Review', itemReviewed: { '@type': 'Article', name: 'x' } }))).includes('jsonld-self-review'));
  });
  test('ordinary "can"/"often" wording in a table is not filler', () => {
    assert.deepEqual(findContentIssues({ sections: [{ heading: 'h', body: 'b', table: [
      { feature: 'Export', pinecone: 'Can export to CSV', pgvector: 'Often done with COPY' },
      { feature: 'Hosting', pinecone: 'Managed only', pgvector: 'Usually self-hosted' },
    ] }] }), []);
  });
  test('a header-less markdown table anywhere in generated text is caught, not just in sections', () => {
    assert.ok(ids(findContentIssues({ outline: { intro: '| Tool |  |\n|---|---|\n| A | B |' } })).includes('table-empty-header'));
  });
});
