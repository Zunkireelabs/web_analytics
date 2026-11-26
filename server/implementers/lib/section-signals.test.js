import test from 'node:test';
import assert from 'node:assert/strict';
import { learnSectionSignals } from './section-signals.js';
import { refineMarkerPlacement, refineRelatedGuidesPlacement } from './expand-placement.js';

const sec = (role, classes, ...headings) => ({ role, classes, textHierarchy: headings.map((t) => ({ tag: 'h2', text: t })) });
const profile = {
  pages: [
    { url: 'https://s.example/a', sections: [sec('content', 'px-4 py-12 prose'), sec('cta', 'px-4 py-12 closing-banner', "Let's talk about your move"), sec('faq', 'faq-block px-4 py-12', 'Questions we hear')] },
    { url: 'https://s.example/b', sections: [sec('content', 'px-4 py-12 prose'), sec('cta', 'px-4 py-12 closing-banner', "Let's talk about your move"), sec('faq', 'faq-block px-4 py-12', 'Questions we hear')] },
    { url: 'https://s.example/c', sections: [sec('hero', 'hero-big px-4'), sec('footer', 'site-footer'), sec('cta', 'v2-nav-mega v2-mm', 'Resources'), sec('cta', 'v2-nav-mega v2-mm', 'Resources')] },
  ],
};

test('a site\'s own class names and recurring headings are learned for its CTA and FAQ sections', () => {
  const s = learnSectionSignals(profile);
  assert.ok(s.cta.test('section class="px-4 closing-banner"'));
  assert.ok(s.cta.test("Let's talk about your move"));
  assert.ok(s.faq.test('div class="faq-block px-4"'));
  assert.ok(s.faq.test('Questions we hear'));
});
test('a class every section shares (px-4, py-12) is never a signal, and neither is a class an ordinary section also has', () => {
  const s = learnSectionSignals(profile);
  assert.equal(s.cta.test('div class="px-4 py-12"'), false);
  assert.equal(s.faq.test('div class="prose"'), false);
});
test('navigation and menu classes are refused even when the profile tagged them as a CTA', () => {
  const s = learnSectionSignals(profile);
  assert.equal(s.cta.test('div class="v2-nav-mega v2-mm"'), false);
  assert.equal(s.cta.test('Resources'), false);
});
test('abbreviated menu classes, legal-page classes and related-reading headings are never a signal', () => {
  const p = { pages: [
    { url: 'u1', sections: [sec('cta', 'v2-mm v2-mm--resources', 'Related insights'), sec('faq', 'legal-body', 'Privacy'), sec('content', 'prose')] },
    { url: 'u2', sections: [sec('cta', 'v2-mm v2-mm--resources', 'Related insights'), sec('faq', 'legal-body', 'Privacy'), sec('content', 'prose')] },
  ] };
  const s = learnSectionSignals(p);
  assert.equal(s.cta, null); assert.equal(s.faq, null);
});
test('a word seen on one page only is not enough', () => {
  const one = { pages: [{ url: 'u1', sections: [sec('cta', 'only-here-banner')] }, { url: 'u2', sections: [sec('content', 'prose')] }] };
  assert.equal(learnSectionSignals(one).cta, null);
});
test('no profile, no pages: nothing learned, nothing breaks', () => {
  assert.deepEqual(learnSectionSignals(null), { faq: null, cta: null });
  assert.deepEqual(learnSectionSignals({ pages: [] }), { faq: null, cta: null });
});

// The placement itself, on a page whose CTA the generic words cannot recognise.
const marker = '{/* SEOAI:EXPANDEDCONTENT:START */}{/* SEOAI:EXPANDEDCONTENT:END */}';
const page = (body) => `<main><section class="intro"><p>Intro.</p></section>${body}\n${marker}\n</main>`;
const CTA = '<section class="closing-banner"><h2>Your next step is simple</h2><a href="/x">Go</a></section>';

const LONG_CTA = `<section class="closing-banner"><h2>Your next step is simple</h2><p>${'We would love to hear about your move and plan it with you. '.repeat(10)}</p><a href="/x">Go</a></section>`;
test('a long closing section is not recognised by shape or by generic words, so without the site\'s words the block stays at the end', () => {
  const r = refineMarkerPlacement(page(LONG_CTA), 'a.jsx', 'EXPANDEDCONTENT', ['faq', 'cta'], {});
  assert.equal(r.moved, false);
});
test('with the site\'s own words learned, the block goes above that closing section even when it is long', () => {
  const signals = learnSectionSignals(profile);
  const r = refineMarkerPlacement(page(LONG_CTA), 'a.jsx', 'EXPANDEDCONTENT', ['faq', 'cta'], { signals });
  assert.equal(r.moved, true);
  assert.ok(r.content.indexOf('EXPANDEDCONTENT:START') < r.content.indexOf('closing-banner'));
});
test('related guides go just before a CTA only the site\'s own words recognise', () => {
  const signals = learnSectionSignals(profile);
  const text = `<main><section><p>Intro.</p></section><section class="faq-block"><h2>Questions we hear</h2></section>${CTA}\n{/* SEOAI:LINKS:START */}{/* SEOAI:LINKS:END */}\n</main>`;
  const r = refineRelatedGuidesPlacement(text, 'a.jsx', 'LINKS', { signals });
  assert.equal(r.moved, true);
  assert.ok(r.content.indexOf('SEOAI:LINKS:START') > r.content.indexOf('faq-block'));
  assert.ok(r.content.indexOf('SEOAI:LINKS:START') < r.content.indexOf('closing-banner'));
});

describe_closing_cta();
function describe_closing_cta() {
  const m = '{/* SEOAI:EXPANDEDCONTENT:START */}{/* SEOAI:EXPANDEDCONTENT:END */}';
  const wrap = (last) => `<main><section class="intro"><h2>About</h2><p>${'Real content. '.repeat(40)}</p></section>${last}\n${m}\n</main>`;
  const place = (last) => refineMarkerPlacement(wrap(last), 'a.jsx', 'EXPANDEDCONTENT', ['faq', 'cta'], {});
  test('a short last section with a heading and a button is a closing call to action, whatever it is called', () => {
    const r = place('<section class="whatever-the-site-calls-it"><h2>Your next step is simple</h2><a class="btn" href="/c">Talk to us</a></section>');
    assert.equal(r.moved, true);
    assert.ok(r.content.indexOf('EXPANDEDCONTENT:START') < r.content.indexOf('whatever-the-site-calls-it'));
  });
  test('a long last section is content, not a call to action', () => {
    const r = place(`<section><h2>More detail</h2><p>${'Long text. '.repeat(80)}</p><a href="/x">Read</a></section>`);
    assert.equal(r.moved, false);
  });
  test('a short last section with nothing to click is not a call to action', () => {
    const r = place('<section><h2>Note</h2><p>A short note.</p></section>');
    assert.equal(r.moved, false);
  });
  test('a name the generic words recognise still wins, and nothing recognisable at all leaves the block where it was', () => {
    const named = place('<section class="cta"><h2>Get started</h2><a href="/c">Go</a></section>');
    assert.equal(named.moved, true);
    const none = refineMarkerPlacement(`<main><div><p>Text</p></div>\n${m}\n</main>`, 'a.jsx', 'EXPANDEDCONTENT', ['faq', 'cta'], {});
    assert.equal(none.moved, false);
  });
}
