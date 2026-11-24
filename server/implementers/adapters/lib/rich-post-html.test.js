import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRichPost, nextSectionId, richSectionHtml, richQaHtml, inlineToHtml, resolveTableMarkup, extractTableCss, applyInsertions, verifyRichEdit, verifyRichBlockEdit, normHeading } from './rich-post-html.js';

// The shape of the real admizz-web-dev raw-HTML posts (10 of 40 sampled): ONE block, numbered or named sections, a table, a CTA, an FAQ section.
const post = ({ ids = ['s1', 's2'], extra = '', style = '<style>.section{margin:0}.elig-table{width:100%}.table-scroll{overflow:auto}</style>', tail = '<div class="cta-banner"><h2>Book</h2></div><section class="section" id="faq"><h2>FAQ</h2><div class="faq-item">q</div></section>' } = {}) =>
  `${style}<div class="container"><div class="quick-facts">facts</div>${ids.map((id, i) => `<section class="section" id="${id}"><h2>Heading ${i + 1}</h2><p>text</p>${i === 0 ? '<ul><li>a</li></ul>' : ''}${i === 1 ? '<div class="table-scroll"><table class="elig-table"><tr><td>x</td></tr></table></div>' : ''}</section>`).join('')}${extra}${tail}</div>`;

describe('reading the page\'s structure', () => {
  test('a numbered page: new sections continue the numbering and go directly above the call to action', () => {
    const html = post();
    const a = analyzeRichPost(html);
    assert.equal(a.ok, true);
    assert.equal(html.slice(a.insertAt, a.insertAt + 24), '<div class="cta-banner">');
    assert.equal(a.idStyle, 'numeric');
    assert.deepEqual([nextSectionId(a, 'x'), nextSectionId(a, 'y')], ['s3', 's4']);
  });
  test('a named page: ids come from the heading and stay unique', () => {
    const a = analyzeRichPost(post({ ids: ['intro', 'courses'] }));
    assert.equal(a.idStyle, 'named');
    assert.equal(nextSectionId(a, 'Visa costs 2027!'), 'visa-costs-2027');
    assert.equal(nextSectionId(a, 'Visa costs 2027'), 'visa-costs-2027-2');
    assert.equal(nextSectionId(a, 'Intro'), 'intro-2', 'never collides with an id already on the page');
  });
  test('the FAQ section is not a content section, and when it comes first the new section goes above it', () => {
    const html = post({ tail: '<section class="section" id="faq"><h2>FAQ</h2></section><div class="cta-banner">x</div>' });
    const a = analyzeRichPost(html);
    assert.ok(html.slice(a.insertAt).startsWith('<section class="section" id="faq"'));
  });
  test('a call to action in the middle of the body is not the end of the body', () => {
    const html = post({ ids: ['s1'], extra: '<div class="inline-cta">mid</div><section class="section" id="s2"><h2>After</h2></section>' });
    const a = analyzeRichPost(html);
    assert.equal(html.slice(a.insertAt, a.insertAt + 24), '<div class="cta-banner">');
  });
  test('what the page already uses is recorded: lists, h3, its own table markup, its headings', () => {
    const a = analyzeRichPost(post());
    assert.deepEqual(a.uses, { h3: false, ul: true, ol: false });
    assert.deepEqual(a.tableMarkup, { wrapperClass: 'table-scroll', tableClass: 'elig-table' });
    assert.ok(a.headings.has('heading 1'));
  });
  test('no safe place is refused with the reason: no sections, no CTA/FAQ after them, sections at different levels', () => {
    assert.match(analyzeRichPost('<div><p>just text</p></div>').error, /no content sections/);
    assert.match(analyzeRichPost(post({ tail: '' })).error, /no call-to-action or FAQ/);
    const nested = '<div><section class="section" id="s1"><h2>A</h2><div><section class="section" id="s2"><h2>B</h2></section></div></section><div class="cta-banner">x</div></div>';
    assert.match(analyzeRichPost(nested).error, /not all at the same level/);
  });
});

describe('the section is written in the page\'s own markup, with only what the page already uses', () => {
  const a = analyzeRichPost(post());
  const base = { id: 's3', uses: a.uses, tableMarkup: a.tableMarkup };
  test('heading, paragraphs and a list; links open in a new tab only when external; everything escaped', () => {
    const r = richSectionHtml({ heading: 'Costs <2027>', body: 'Fees: [GOV.UK](https://www.gov.uk/x) and [guide](/uk) **now**.\n\n- rent & food\n- travel' }, base);
    assert.equal(r.html, '<section class="section" id="s3"><h2>Costs &lt;2027&gt;</h2><p>Fees: <a href="https://www.gov.uk/x" target="_blank" rel="noopener noreferrer">GOV.UK</a> and <a href="/uk">guide</a> <strong>now</strong>.</p><ul><li>rent &amp; food</li><li>travel</li></ul></section>');
  });
  test('a table uses the page\'s own table markup', () => {
    const r = richSectionHtml({ heading: 'Compare', body: 'Lead.', table: [{ feature: 'Fee', uk: '£1' }] }, base);
    assert.match(r.html, /<div class="table-scroll"><table class="elig-table"><thead><tr><th>Feature<\/th><th>Uk<\/th><\/tr><\/thead>/);
  });
  test('refused, never approximated: an ordered list the page does not use, a table with no design to copy, no heading', () => {
    assert.equal(richSectionHtml({ heading: 'H', body: '1. one' }, base).reason, 'page-style-unknown');
    assert.equal(richSectionHtml({ heading: 'H', body: 'b', table: [{ a: '1' }] }, { ...base, tableMarkup: null }).reason, 'no-table-design');
    assert.equal(richSectionHtml({ heading: ' ', body: 'b' }, base).reason, 'draft-not-ready');
  });
  test('Q&A on a page that uses h3: one section, each question an h3 with its answer', () => {
    let n = 0; const idFor = () => `q${++n}`;
    const r = richQaHtml([{ question: 'Is it?', answer: 'Yes.' }, { question: 'Seen?', answer: 'x' }], { idFor, uses: { ...a.uses, h3: true }, existing: new Set([normHeading('seen')]) });
    assert.equal(r.html, '<section class="section" id="q1"><h3>Is it?</h3><p>Yes.</p></section>');
    assert.deepEqual(r.skipped, ['Seen?']);
  });
  test('Q&A on a page with only h2: each question is its own section in the heading style the page already has', () => {
    let n = 0; const idFor = () => `q${++n}`;
    const r = richQaHtml([{ question: 'Is it?', answer: 'Yes.' }, { question: 'And this?', answer: 'No.' }], { idFor, uses: a.uses });
    assert.equal(r.html, '<section class="section" id="q1"><h2>Is it?</h2><p>Yes.</p></section><section class="section" id="q2"><h2>And this?</h2><p>No.</p></section>');
    assert.equal(richQaHtml([{ question: 'q?', answer: '' }], { idFor, uses: a.uses }).reason, 'draft-not-ready');
    assert.equal(richQaHtml([], { idFor, uses: a.uses }).html, '');
  });
  test('inline text: bold, italic and escaping', () => assert.equal(inlineToHtml('a *b* **c** <i>'), 'a <em>b</em> <strong>c</strong> &lt;i&gt;'));
});

describe('which table markup a page may use', () => {
  const SITE = { wrapperClass: 'table-scroll', tableClass: 'elig-table' };
  test('its own wins', () => assert.deepEqual(resolveTableMarkup({ tableMarkup: { wrapperClass: 'w', tableClass: 't' } }, SITE), { wrapperClass: 'w', tableClass: 't' }));
  test('the site\'s, when the page\'s own CSS defines both classes, or when it has no CSS of its own', () => {
    assert.deepEqual(resolveTableMarkup({ tableMarkup: null, styleText: '.elig-table{} .table-scroll{}' }, SITE), SITE);
    assert.deepEqual(resolveTableMarkup({ tableMarkup: null, styleText: '' }, SITE), SITE);
  });
  test('none, when the page has its own CSS that does not define them: how a table would look is unknown', () => {
    assert.equal(resolveTableMarkup({ tableMarkup: null, styleText: '.section{}' }, SITE), null);
    assert.equal(resolveTableMarkup({ tableMarkup: null, styleText: '' }, null), null);
  });
});

describe('the proof', () => {
  const html = post(); const a = analyzeRichPost(html);
  const frag = '<section class="section" id="s3"><h2>New</h2><p>x</p></section>';
  const after = html.slice(0, a.insertAt) + frag + html.slice(a.insertAt);
  test('a pure insertion at the intended place passes', () => assert.deepEqual(verifyRichEdit(html, after, { at: a.insertAt, fragment: frag }), { ok: true }));
  test('any other change, a wrong place, or a section that is not at the same level is caught', () => {
    assert.equal(verifyRichEdit(html, after.replace('Heading 1', 'Changed'), { at: a.insertAt, fragment: frag }).ok, false);
    assert.equal(verifyRichEdit(html, html.slice(0, 5) + frag + html.slice(5), { at: a.insertAt, fragment: frag }).ok, false);
    const bad = '<div><section class="section" id="s3"><h2>New</h2></section></div>';
    const nested = html.slice(0, a.insertAt) + bad + html.slice(a.insertAt);
    assert.equal(verifyRichEdit(html, nested, { at: a.insertAt, fragment: bad }).ok, false);
  });
  test('the whole-file proof: only the page block\'s html differs, and only by the insertion', () => {
    const doc = (h, extra = {}) => `${JSON.stringify({ _id: 'p', title: 'T', content: [{ _key: 'a', _type: 'rawHtml', html: h }], seo: { x: 1 }, ...extra }, null, 2)}\n`;
    assert.equal(verifyRichBlockEdit(doc(html), doc(after), { blockIndex: 0, at: a.insertAt, fragment: frag }).ok, true);
    assert.equal(verifyRichBlockEdit(doc(html), doc(after, { title: 'T2' }), { blockIndex: 0, at: a.insertAt, fragment: frag }).ok, false);
    assert.equal(verifyRichBlockEdit(doc(html), doc(after.replace('text', 'TEXT')), { blockIndex: 0, at: a.insertAt, fragment: frag }).ok, false);
  });
});

describe('the site\'s own table rules, copied from its stylesheet', () => {
  const SRC = `export const RICH_POST_FONT_LINK = "x";
export const RICH_POST_CSS = \`
.section{margin-bottom:56px}
.table-scroll{width:100%;overflow-x:auto;margin:24px 0}
.elig-table{width:100%;border-collapse:collapse}
.elig-table th{background:#0d1b2a;color:#fff}
.elig-table tr:nth-child(even) td{background:#faf8f3}
.callout{padding:18px}
\`;
export const BLOG_SHARED_OVERRIDES = \`
.blog-raw-content .elig-table th{background:#001353!important}
\`;`;
  const M = { wrapperClass: 'table-scroll', tableClass: 'elig-table' };
  test('every rule for the wrapper or the table in the shared stylesheet, nothing else, never the renderer\'s scoped overrides', () => {
    assert.equal(extractTableCss(SRC, M), '.table-scroll{width:100%;overflow-x:auto;margin:24px 0}\n.elig-table{width:100%;border-collapse:collapse}\n.elig-table th{background:#0d1b2a;color:#fff}\n.elig-table tr:nth-child(even) td{background:#faf8f3}');
  });
  test('nothing when the stylesheet defines none of them, or has no such block', () => {
    assert.equal(extractTableCss(SRC, { wrapperClass: 'a', tableClass: 'b' }), null);
    assert.equal(extractTableCss('const x = 1;', M), null);
    assert.equal(extractTableCss(SRC, null), null);
  });
  test('insertions apply in one pass against the ORIGINAL offsets, in any order', () => {
    assert.equal(applyInsertions('0123456789', [{ at: 7, text: 'B' }, { at: 2, text: 'A' }]), '01A23456B789');
  });
  test('the proof accepts exactly the intended insertions (css and section) and nothing else', () => {
    const html = post({ style: '<style>.section{margin:0}</style>' });
    const a = analyzeRichPost(html);
    const ins = [{ at: a.styleEnd, text: '\n.elig-table{x:1}\n' }, { at: a.insertAt, text: '<section class="section" id="s3"><h2>N</h2></section>' }];
    const after = applyInsertions(html, ins);
    assert.deepEqual(verifyRichEdit(html, after, { insertions: ins }), { ok: true });
    assert.equal(verifyRichEdit(html, after.replace('margin:0', 'margin:9'), { insertions: ins }).ok, false);
    assert.ok(a.styleEnd > 0 && html.slice(a.styleEnd, a.styleEnd + 8) === '</style>');
  });
});
