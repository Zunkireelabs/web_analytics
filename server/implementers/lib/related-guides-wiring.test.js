import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergeValues } from './marker-merge.js';
import { extractRelatedGuidesCard, standardRelatedGuides } from './related-guides-card.js';
import { parseTargetMeta, enrichSuggestionsWithMeta } from './target-meta.js';

const grid = `<section class="py-14"><div><h2>Related Articles</h2><div class="grid">
${[1, 2, 3].map((n) => `<a class="group card" href="/p${n}"><img src="/i${n}.webp"><h3>Title ${n}</h3><p>Excerpt ${n}.</p></a>`).join('')}</div></div></section>`;
const own = extractRelatedGuidesCard(grid);
const suggestions = [
  { anchorText: 'visa costs', targetUrl: '/guides/visa-costs', rationale: 'r', meta: { title: 'Visa costs in 2027', description: 'What a UK visa really costs.', image: 'https://x.test/v.jpg' } },
  { anchorText: 'student housing', targetUrl: '/guides/housing', rationale: 'r' },
];
const build = (templates) => buildMergeValues('internal-links', { suggestions }, 'visible', templates, null, {});

describe('internal-links: cards in the site\'s own design when it has one', () => {
  test('a saved own card is used, filled with the target page\'s real data, and the site\'s classes are kept', () => {
    const r = build({ relatedGuidesCard: own });
    assert.equal(r.ok, true);
    assert.match(r.values.links, /class="group card"/);
    assert.match(r.values.links, /href="\/guides\/visa-costs"/); assert.match(r.values.links, /Visa costs in 2027/); assert.match(r.values.links, /What a UK visa really costs\./);
    assert.match(r.values.links, /src="https:\/\/x\.test\/v\.jpg"/);
    assert.doesNotMatch(r.values.links, /\{\{/);
  });
  test('a target with no lookup result still gets a card: its anchor text is the title, with no image or description', () => {
    const html = build({ relatedGuidesCard: own }).values.links;
    assert.match(html, /student housing/); assert.match(html, /href="\/guides\/housing"/);
  });
});

describe('a site with no card of its own: the standard card from its measured look, flagged for review', () => {
  const tokens = { bodyColor: 'rgb(30, 30, 40)', bodyBg: 'rgb(255, 255, 255)', radius: 16, h2Font: '"Plus Jakarta Sans"', h2Size: '32px', h2Weight: '700', h2Color: 'rgb(10, 10, 20)', container: 760, sectionPad: '80px' };
  test('built from the site\'s own measured values, with a review note', () => {
    const r = build({ relatedGuidesStandard: tokens });
    assert.equal(r.ok, true);
    assert.match(r.values.links, /data-seoai-standard-card/); assert.match(r.values.links, /border-radius:16px/); assert.match(r.values.links, /Plus Jakarta Sans/); assert.match(r.values.links, /max-width:760px/);
    assert.equal(r.notes.length, 1); assert.match(r.notes[0], /Check how it looks before approving/);
    assert.doesNotMatch(r.values.links, /<style/, 'no stylesheet is added to a client page');
  });
  test('a pill-button radius (40px) is kept in a range a card can carry, and a tiny one is not squared off to nothing', () => {
    assert.match(build({ relatedGuidesStandard: { ...tokens, radius: 40 } }).values.links, /border-radius:20px/);
    assert.match(build({ relatedGuidesStandard: { ...tokens, radius: 0 } }).values.links, /border-radius:4px/);
  });
  test('the site\'s own card wins over the standard when both exist', () => {
    const r = build({ relatedGuidesCard: own, relatedGuidesStandard: tokens });
    assert.match(r.values.links, /class="group card"/); assert.equal(r.notes?.length || 0, 0);
  });
  test('standardRelatedGuides escapes content, shortens long descriptions and drops a missing image', () => {
    const r = standardRelatedGuides([{ url: '/a', title: 'T <script>', description: 'x'.repeat(300) }], tokens);
    assert.match(r.html, /T &lt;script&gt;/); assert.doesNotMatch(r.html, /<img/); assert.match(r.html, /\.\.\.<\/p>/);
    assert.equal(standardRelatedGuides([], tokens).ok, false);
  });
});

describe('every other site is unchanged: no card saved means the plain list it always got', () => {
  test('no relatedGuides settings -> the existing list markup, no notes, no card', () => {
    const r = build({});
    assert.equal(r.ok, true); assert.match(r.values.links, /href="\/guides\/visa-costs"/);
    assert.doesNotMatch(r.values.links, /data-seoai-standard-card|group card/);
    assert.equal(r.notes, undefined);
  });
});

describe('target page lookup', () => {
  const page = `<html><head><title>Visa costs 2027 | Admizz</title><meta property="og:title" content="Visa costs in 2027 | Admizz"><meta name="description" content="Plain description."><meta property="og:description" content="OG description."><meta property="og:image" content="/img/v.jpg"></head></html>`;
  test('reads title, description and image from the page\'s own tags, makes the image absolute and drops the site-name suffix', () => {
    const m = parseTargetMeta(page, 'https://admizzeducation.com/guides/visa-costs');
    assert.deepEqual(m, { title: 'Visa costs in 2027', description: 'OG description.', image: 'https://admizzeducation.com/img/v.jpg' });
  });
  test('a page with none of those tags gives nulls, never invented text', () => {
    assert.deepEqual(parseTargetMeta('<html><body>hi</body></html>', 'https://a.com/x'), { title: null, description: null, image: null });
  });
  test('enrich adds meta where the lookup works and leaves the suggestion alone where it does not (never throws)', async () => {
    const fetchHtml = async (url) => { if (url.endsWith('/bad')) throw new Error('blocked'); return page; };
    const out = await enrichSuggestionsWithMeta({ website_domain: 'admizzeducation.com' }, [{ anchorText: 'a', targetUrl: '/ok' }, { anchorText: 'b', targetUrl: '/bad' }, { anchorText: 'c' }], { fetchHtml });
    assert.equal(out[0].meta.title, 'Visa costs in 2027'); assert.equal(out[1].meta, undefined); assert.equal(out[2].meta, undefined);
    assert.equal(out[0].targetUrl, '/ok', 'the link target itself is never rewritten');
  });
});
