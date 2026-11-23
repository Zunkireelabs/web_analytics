import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { refineMarkerPlacement, refineRelatedGuidesPlacement } from './expand-placement.js';
import { usesStandardSectionOrder, standardPlacementFor, STANDARD_SECTION_ORDER } from './section-order.js';

const EXP = 'EXPAND'; const REL = 'RELATED';
const mk = (n) => `<!-- SEOAI:${n}:START --><!-- SEOAI:${n}:END -->`;
const content = '<section class="content"><h2>Moving to Kettering</h2><p>Long enough body text about the service.</p></section>';
const faq = '<section class="faq"><h2>Frequently asked questions</h2><p>Q and A.</p></section>';
const cta = '<section class="v2-final"><h2>Ready to book?</h2><a href="/contact">Get a quote</a></section>';
const page = (...parts) => parts.join('\n');
const order = (html) => [...html.matchAll(/class="(content|faq|v2-final)"|SEOAI:(EXPAND|RELATED):START/g)].map((m) => m[1] || m[2]);

describe('the standard order is an explicit, frozen rule', () => {
  test('content, expanded content, FAQ, related guides, CTA', () => {
    assert.deepEqual([...STANDARD_SECTION_ORDER], ['content', 'expand-content', 'faq', 'related-guides', 'cta']);
    assert.ok(Object.isFrozen(STANDARD_SECTION_ORDER));
  });
});

describe('on by default, held back only with sectionOrder "off" (MOBILISE is held until its owner has seen it)', () => {
  const on = { url_file_map: { siteRoot: {} } };
  test('every site is on unless it says "off"', () => {
    for (const site of [on, { url_file_map: {} }, { url_file_map: { siteRoot: { sectionOrder: 'standard' } } }, { url_file_map: { siteRoot: { sectionOrder: true } } }]) {
      assert.equal(usesStandardSectionOrder(site), true);
    }
    assert.equal(usesStandardSectionOrder({ url_file_map: { siteRoot: { sectionOrder: 'off' } } }), false);
  });
  test('an "off" site gets no placement instruction at all', () => {
    const off = { url_file_map: { siteRoot: { sectionOrder: 'off' } } };
    assert.equal(standardPlacementFor(off, 'expand-content', 'expandedContent'), null);
    assert.equal(standardPlacementFor(off, 'internal-links', 'links'), null);
  });
  test('no site at all gives no instruction (nothing to place against)', () => {
    assert.equal(standardPlacementFor(null, 'expand-content', 'expandedContent'), null);
  });
  test('the instruction per fix type', () => {
    assert.deepEqual(standardPlacementFor(on, 'expand-content', 'expandedContent'), { field: 'expandedContent', mode: 'before-trailing', beforeRoles: ['faq', 'cta'] });
    assert.deepEqual(standardPlacementFor(on, 'internal-links', 'links'), { field: 'links', mode: 'related-guides' });
    assert.equal(standardPlacementFor(on, 'faq', 'faq'), null, 'no ordering rule for other fix types');
    assert.equal(standardPlacementFor(on, 'expand-content', undefined), null);
  });
});

describe('expanded content: above the FAQ, or above the CTA when there is no FAQ', () => {
  const place = (p) => refineMarkerPlacement(`${p}\n${mk(EXP)}\n`, 'page.njk', EXP, ['faq', 'cta']);
  test('content + FAQ + CTA: goes above the FAQ', () => assert.deepEqual(order(place(page(content, faq, cta)).content), ['content', 'EXPAND', 'faq', 'v2-final']));
  test('content + CTA (no FAQ): goes just above the CTA', () => assert.deepEqual(order(place(page(content, cta)).content), ['content', 'EXPAND', 'v2-final']));
  test('content only: left exactly where the engine put it', () => { const r = place(content); assert.equal(r.moved, false); });
  test('a marker already on the page is never moved', () => {
    const r = refineMarkerPlacement(`${content}\n${faq}\n${mk(EXP)}\n`, 'page.njk', EXP, ['faq', 'cta'], { markerWasPresent: true });
    assert.equal(r.moved, false); assert.equal(r.reason, 'marker-already-on-page');
  });
});

describe('related guides: after the FAQ, before the CTA', () => {
  const place = (p) => refineRelatedGuidesPlacement(`${p}\n${mk(REL)}\n`, 'page.njk', REL);
  test('content + FAQ + CTA: between the FAQ and the CTA', () => assert.deepEqual(order(place(page(content, faq, cta)).content), ['content', 'faq', 'RELATED', 'v2-final']));
  test('content + CTA (no FAQ): just before the CTA', () => assert.deepEqual(order(place(page(content, cta)).content), ['content', 'RELATED', 'v2-final']));
  test('content + FAQ (no CTA): just after the FAQ', () => assert.deepEqual(order(place(page(content, faq)).content), ['content', 'faq', 'RELATED']));
  test('content only: untouched', () => { const r = place(content); assert.equal(r.moved, false); assert.equal(r.reason, 'no-trailing-faq-or-cta'); });
  test('both blocks on one page end up in the standard order, whichever is created first', () => {
    const p = page(content, faq, cta);
    const a = refineMarkerPlacement(`${p}\n${mk(EXP)}\n`, 'p.njk', EXP, ['faq', 'cta']).content;
    const both = refineRelatedGuidesPlacement(`${a}\n${mk(REL)}\n`, 'p.njk', REL).content;
    assert.deepEqual(order(both), ['content', 'EXPAND', 'faq', 'RELATED', 'v2-final']);
    const b = refineRelatedGuidesPlacement(`${p}\n${mk(REL)}\n`, 'p.njk', REL).content;
    const both2 = refineMarkerPlacement(`${b}\n${mk(EXP)}\n`, 'p.njk', EXP, ['faq', 'cta']).content;
    assert.deepEqual(order(both2), ['content', 'EXPAND', 'faq', 'RELATED', 'v2-final']);
  });
  test('nothing else on the page is changed: removing the marker gives back the original', () => {
    const p = page(content, faq, cta);
    assert.equal(place(p).content.replace(mk(REL), '').replace(/\n{2,}/g, '\n').trim(), p.replace(/\n{2,}/g, '\n').trim());
  });
  test('JSX pages work the same way', () => {
    const jsx = '{/* SEOAI:RELATED:START */}{/* SEOAI:RELATED:END */}';
    const body = '<main><section><h2>About</h2><p>Body text.</p></section>\n<section className="faq"><h2>FAQ</h2></section>\n<section className="cta"><h2>Contact us</h2></section></main>';
    const r = refineRelatedGuidesPlacement(`${body}\n${jsx}\n`, 'page.tsx', REL);
    assert.equal(r.moved, true);
    assert.ok(r.content.indexOf('className="faq"') < r.content.indexOf('SEOAI:RELATED:START') && r.content.indexOf('SEOAI:RELATED:START') < r.content.indexOf('className="cta"'));
  });
  test('markdown pages are left alone (no sections to order against)', () => {
    const r = refineRelatedGuidesPlacement(`## A\ntext\n\n## FAQ\nq\n\n${mk(REL)}\n`, 'page.md', REL);
    assert.equal(r.moved, false);
  });
  test('a marker inside a section is never placed relative to it', () => {
    const inside = `<section class="faq"><h2>FAQ</h2>${mk(REL)}</section>`;
    assert.equal(refineRelatedGuidesPlacement(inside, 'page.njk', REL).moved, false);
  });
});
