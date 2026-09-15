import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  countCurrentlyVisibleFaqPages, decideFaqRenderMode, decideFaqRenderModeForDataDrivenPage,
  templateRendersItemsField, resolveFaqRenderMode,
} from './faq-render-mode.js';

function siteWithPages(pages) {
  const url_file_map = { pages: {} };
  for (const p of pages) url_file_map.pages[p] = { file: `src/pages/${p.replace(/\W+/g, '_')}.njk` };
  return { id: 1, visible_faq_baseline: 0, url_file_map };
}

describe('countCurrentlyVisibleFaqPages', () => {
  test('counts a page only if its CURRENT live content still shows a visible FAQ signal', async () => {
    const site = siteWithPages(['/a/', '/b/']);
    const listPages = async () => ['/a/', '/b/'];
    // /a/ still has a real Q&A loop (strong visible signal), /b/'s FAQ was
    // removed since — its current content has nothing left.
    const fetchFile = async (s, filePath) => {
      if (filePath.includes('_a_')) return { content: '{% for item in faq %}{{ item.question }}{{ item.answer }}{% endfor %}' };
      return { content: '<p>just a plain page now</p>' };
    };
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 1);
  });

  test('a page whose FAQ was removed does not count, even though it was historically pushed as visible', async () => {
    const site = siteWithPages(['/a/']);
    const listPages = async () => ['/a/'];
    const fetchFile = async () => ({ content: '<p>no faq here anymore</p>' });
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 0);
  });

  test('a page whose file no longer exists live does not count', async () => {
    const site = siteWithPages(['/a/']);
    const listPages = async () => ['/a/'];
    const fetchFile = async () => null;
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 0);
  });

  test('a page no longer mapped in url_file_map at all does not count', async () => {
    const site = siteWithPages([]);
    const listPages = async () => ['/gone/'];
    const fetchFile = async () => { throw new Error('should never be called — page has no file mapping'); };
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 0);
  });

  test('adds the organic visible_faq_baseline on top of the live-verified drafted count', async () => {
    const site = { ...siteWithPages(['/a/']), visible_faq_baseline: 3 };
    const listPages = async () => ['/a/'];
    const fetchFile = async () => ({ content: '{% for item in faq %}{{ item.question }}{{ item.answer }}{% endfor %}' });
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 4);
  });

  test('a page dropping below the cap frees up a slot again (regression check for the historical-count bug)', async () => {
    // Cap of 2: /a/ still visible, /b/'s FAQ was removed since it was pushed.
    // The historical count (2 pages ever pushed) would wrongly say "at cap".
    // The live-verified count (1 still visible) correctly says there's room.
    const site = { ...siteWithPages(['/a/', '/b/']), visible_faq_cap: 2 };
    const listPages = async () => ['/a/', '/b/'];
    const fetchFile = async (s, filePath) => {
      if (filePath.includes('_a_')) return { content: '{% for item in faq %}{{ item.question }}{{ item.answer }}{% endfor %}' };
      return { content: '<p>removed</p>' };
    };
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 1);
    assert.ok(count < site.visible_faq_cap, 'a freed-up slot must be reflected as room under the cap');
  });
});

// The rule these cover: a page never gets a second VISIBLE FAQ. The live
// page is the only signal that holds regardless of where the existing FAQ
// lives — a partial, a layout, or a shared data file looped elsewhere are all
// invisible to a scan of the page's own template file.
describe('decideFaqRenderMode — never a second visible FAQ', () => {
  const site = { id: 1, visible_faq_cap: 5, visible_faq_baseline: 0, url_file_map: { pages: {} } };

  test('forces schema-only when the live page already shows an FAQ, even though its template file has none', async () => {
    // The template file is deliberately clean — this is the partial/data-file
    // case, where template scanning alone would wrongly say "visible".
    const readLivePage = async () => ({ ok: true, analysis: { faqVisibleQuestionCount: 10 } });
    const result = await decideFaqRenderMode(site, '/resources/', '<p>no faq markup in this file at all</p>', 'faq', { readLivePage });
    assert.equal(result.mode, 'schema-only');
    assert.equal(result.source, 'live-page');
    assert.match(result.reason, /10 questions/);
  });

  test('a single question-shaped heading is not an FAQ — does not suppress a legitimate first FAQ', async () => {
    const readLivePage = async () => ({ ok: true, analysis: { faqVisibleQuestionCount: 1 } });
    const result = await decideFaqRenderMode(site, '/team/', '<p>plain page</p>', 'faq', { readLivePage });
    assert.notEqual(result.source, 'live-page');
  });

  test('a failed live fetch falls through rather than blocking the draft', async () => {
    const readLivePage = async () => ({ ok: false });
    const result = await decideFaqRenderMode(site, '/team/', '<p>plain page</p>', 'faq', { readLivePage });
    assert.notEqual(result.source, 'live-page');
  });

  test('a thrown live fetch is caught, not propagated', async () => {
    const readLivePage = async () => { throw new Error('network down'); };
    const result = await decideFaqRenderMode(site, '/team/', '<p>plain page</p>', 'faq', { readLivePage });
    assert.notEqual(result.source, 'live-page');
  });
});

describe('templateRendersItemsField', () => {
  test('recognizes the real PR #99 Nunjucks loop shape ("comp.faqs")', () => {
    const source = '{% if comp.faqs and comp.faqs.length > 0 %}{% for faq in comp.faqs %}{{ faq.question }}{% endfor %}{% endif %}';
    assert.equal(templateRendersItemsField(source, 'faqs'), true);
  });

  test('recognizes a plain top-level loop variable ("faqs")', () => {
    assert.equal(templateRendersItemsField('{% for item in faqs %}{{ item.question }}{% endfor %}', 'faqs'), true);
  });

  test('recognizes a JSX .map form near the field', () => {
    assert.equal(templateRendersItemsField('{comp.faqs.map((f) => <div>{f.question}</div>)}', 'faqs'), true);
  });

  test('false when the template has FAQ-shaped markup but never loops the actual field', () => {
    // Same class of false-positive render-inspector.js's own strong-signal
    // scan would produce against a shared, data-conditional layout: literal
    // "FAQPage"/"accordion" text present, but no real render mechanism for
    // THIS field.
    const source = '<h2>Frequently Asked Questions</h2><div class="accordion"></div><script>{"@type":"FAQPage"}</script>';
    assert.equal(templateRendersItemsField(source, 'faqs'), false);
  });

  test('false for empty/missing inputs', () => {
    assert.equal(templateRendersItemsField('', 'faqs'), false);
    assert.equal(templateRendersItemsField('{% for f in comp.faqs %}', ''), false);
    assert.equal(templateRendersItemsField(null, 'faqs'), false);
  });
});

describe('decideFaqRenderModeForDataDrivenPage', () => {
  const site = { id: 1, visible_faq_cap: 5, visible_faq_baseline: 0, url_file_map: { pages: {} } };

  test('visible when the live page has no existing FAQ and the cap is open', async () => {
    const readLivePage = async () => ({ ok: true, analysis: { faqVisibleQuestionCount: 0 } });
    const result = await decideFaqRenderModeForDataDrivenPage(site, '/compare/a-vs-b/', { readLivePage });
    assert.equal(result.mode, 'visible');
    assert.ok(result.confidence >= 70);
  });

  test('schema-only when the live page already shows a visible FAQ', async () => {
    const readLivePage = async () => ({ ok: true, analysis: { faqVisibleQuestionCount: 3 } });
    const result = await decideFaqRenderModeForDataDrivenPage(site, '/compare/a-vs-b/', { readLivePage });
    assert.equal(result.mode, 'schema-only');
    assert.equal(result.source, 'live-page');
  });

  test('schema-only when the sitewide visible-FAQ cap is already exhausted', async () => {
    const readLivePage = async () => ({ ok: true, analysis: { faqVisibleQuestionCount: 0 } });
    const cappedSite = { ...site, visible_faq_cap: 0 };
    const result = await decideFaqRenderModeForDataDrivenPage(cappedSite, '/compare/a-vs-b/', { readLivePage });
    assert.equal(result.mode, 'schema-only');
    assert.equal(result.source, 'cap');
  });
});

describe('resolveFaqRenderMode — pagination/data-array routes with no per-page file', () => {
  const site = {
    id: 1, visible_faq_cap: 5, visible_faq_baseline: 0,
    url_file_map: {
      pages: {},
      patterns: [{
        match: '^/compare/([^/]+)/?$',
        adapters: { faq: { id: 'data-array-content', dataFile: 'src/_data/comparisons.js', itemsField: 'faqs' } },
      }],
    },
  };

  test('routes to decideFaqRenderModeForDataDrivenPage instead of the generic "no-template" confidence-0 stop', async () => {
    const fetchFile = async () => { throw new Error('should not fetch a per-page file — there is none'); };
    const result = await resolveFaqRenderMode(site, { content: { page: 'https://example.com/compare/a-vs-b/' } }, { fetchFile });
    assert.notEqual(result.source, 'no-template');
    assert.ok(result.mode); // a real decision, not a stop
  });

  test('still falls through to the honest "no-template" stop when there is no matching adapter at all', async () => {
    const bareSite = { ...site, url_file_map: { pages: {}, patterns: [] } };
    const fetchFile = async () => null;
    const result = await resolveFaqRenderMode(bareSite, { content: { page: 'https://example.com/unmapped/' } }, { fetchFile });
    assert.equal(result.source, 'no-template');
    assert.equal(result.mode, null);
  });
});
