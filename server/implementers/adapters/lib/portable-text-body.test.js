import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionKeys, rendererCapabilities, inferTableMarkup, tableHtml, inlineToSpans, sectionToBlocks, insertionIndex, ctaStart, existingHeadings,
  normalizeHeading, isCanonicalJson, canonicalJson, verifyBodyEdit, isAiKey, newAiKey, isCtaBlock, rawHtmlDominates, qaToBlocks,
} from './portable-text-body.js';

// The shape of admizz-web-dev's src/components/PortableTextRenderer.tsx (read from the live repo on 2026-11-24), reduced to its structure.
const RENDERER = `
const components = {
  block: {
    h2: ({ children }) => (<h2 className={a}>{children}</h2>),
    h3: ({ children }) => (<h3>{children}</h3>),
    h4: ({ children }) => (<h4>{children}</h4>),
    normal: ({ children }) => (<p className={blogP.className}>{children}</p>),
    blockquote: ({ children }) => (<blockquote>{children}</blockquote>),
  },
  marks: {
    strong: ({ children }) => <strong>{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    link: ({ children, value }) => { const href = value?.href || "#"; return (<a href={href}>{children}</a>); },
  },
  list: { bullet: ({ children }) => (<ul>{children}</ul>), number: ({ children }) => (<ol>{children}</ol>) },
  listItem: { bullet: ({ children }) => (<li>{children}</li>), number: ({ children }) => (<li>{children}</li>) },
  types: {
    image: ({ value }) => { if (!value?.asset) return null; return (<figure />); },
    rawHtml: ({ value }) => { if (!value?.html) return null; const f = (css) => css.replace(/([^{}]+)\\{([^{}]*)\\}/g, (m) => m); return (<div />); },
  },
};`;
const CAPS = rendererCapabilities(RENDERER);
const MARKUP = { wrapperClass: 'table-scroll', tableClass: 'elig-table' };
let n = 0; const key = () => `k${String(++n).padStart(11, '0')}`;
const para = (text, style = 'normal') => ({ _key: key(), _type: 'block', children: [{ _key: key(), _type: 'span', marks: [], text }], markDefs: [], style });
const cta = () => ({ _key: key(), _type: 'rawHtml', html: '<div class="cta-banner">Book a call</div>' });

describe('what the renderer draws is read from its source', () => {
  test('block styles, lists, marks and block types', () => {
    assert.deepEqual([...CAPS.blockStyles], ['h2', 'h3', 'h4', 'normal', 'blockquote']);
    assert.deepEqual([...CAPS.listTypes], ['bullet', 'number']);
    assert.deepEqual([...CAPS.marks], ['strong', 'em', 'link']);
    assert.deepEqual([...CAPS.types], ['image', 'rawHtml'], 'braces and regexes inside a component do not leak keys');
  });
  test('a renderer with no table or html type yields none', () => {
    assert.equal(rendererCapabilities('const c = { block: { normal: () => null }, types: { image: () => null } };').types.has('rawHtml'), false);
  });
  test('nothing found when the source has no such section', () => assert.deepEqual(sectionKeys('const x = 1;', 'block'), []));
});

describe('the site\'s own table markup', () => {
  const withTable = (cls = 'elig-table', wrap = 'table-scroll') => `<section><div class="${wrap}"><table class="${cls}"><tr><td>x</td></tr></table></div></section>`;
  test('inferred from tables the site\'s own posts already contain', () => {
    assert.deepEqual(inferTableMarkup([withTable(), withTable(), withTable(), withTable('other-table', 'w')]), { ...MARKUP, posts: 3 });
  });
  test('one or two posts are not a convention: no markup is invented', () => {
    assert.equal(inferTableMarkup([withTable(), withTable()]), null);
    assert.equal(inferTableMarkup([]), null);
  });
  test('the table is written with that markup, headers from the keys, and every value escaped', () => {
    const html = tableHtml([{ feature: 'Cost <b>', this_option: 'A & B' }, { feature: 'Time', this_option: '"fast"' }], MARKUP);
    assert.equal(html, '<div class="table-scroll"><table class="elig-table"><thead><tr><th>Feature</th><th>This option</th></tr></thead><tbody><tr><td>Cost &lt;b&gt;</td><td>A &amp; B</td></tr><tr><td>Time</td><td>&quot;fast&quot;</td></tr></tbody></table></div>');
  });
});

describe('text becomes the site\'s own blocks', () => {
  test('links: external open in a new tab, internal do not; bold and italic become marks', () => {
    const { children, markDefs } = inlineToSpans('See [GOV.UK](https://www.gov.uk/x) and [our guide](/uk-visa) for **fees** and *dates*.', key);
    assert.deepEqual(markDefs.map((d) => [d.blank, d.href]), [[true, 'https://www.gov.uk/x'], [false, '/uk-visa']]);
    assert.deepEqual(children.map((c) => c.text), ['See ', 'GOV.UK', ' and ', 'our guide', ' for ', 'fees', ' and ', 'dates', '.']);
    assert.deepEqual(children.find((c) => c.text === 'fees').marks, ['strong']);
    assert.deepEqual(children.find((c) => c.text === 'dates').marks, ['em']);
    assert.deepEqual(children.find((c) => c.text === 'GOV.UK').marks, [markDefs[0]._key]);
  });
  test('a section becomes an h2, paragraphs, bullet and numbered lists, in the exact block shape of the site', () => {
    const r = sectionToBlocks({ heading: 'Visa costs', body: 'Intro line one.\nstill the same paragraph.\n\n- first\n- second\n\n1. step one\n2. step two\n\nClosing.' }, { capabilities: CAPS, newKey: key });
    assert.equal(r.ok, true);
    assert.deepEqual(r.blocks.map((b) => `${b.style}${b.listItem ? ':' + b.listItem : ''}`), ['h2', 'normal', 'normal:bullet', 'normal:bullet', 'normal:number', 'normal:number', 'normal']);
    assert.equal(r.blocks[1].children[0].text, 'Intro line one. still the same paragraph.');
    assert.deepEqual(Object.keys(r.blocks[2]).sort(), ['_key', '_type', 'children', 'level', 'listItem', 'markDefs', 'style']);
    assert.equal(r.blocks[2].level, 1);
  });
  test('a table becomes the site\'s own table block (rawHtml)', () => {
    const r = sectionToBlocks({ heading: 'Compare', body: 'Lead.', table: [{ a: '1', b: '2' }] }, { capabilities: CAPS, tableMarkup: MARKUP, newKey: key });
    const last = r.blocks.at(-1);
    assert.equal(last._type, 'rawHtml');
    assert.match(last.html, /^<div class="table-scroll"><table class="elig-table">/);
  });
  test('refused, never approximated: a table with no table design found, or a renderer that cannot draw it', () => {
    const t = { heading: 'H', body: 'b', table: [{ a: '1' }] };
    assert.equal(sectionToBlocks(t, { capabilities: CAPS, newKey: key }).reason, 'no-table-design');
    const noHtml = rendererCapabilities('const c = { block: { h2: 1, normal: 1 }, types: { image: 1 } };');
    assert.equal(sectionToBlocks(t, { capabilities: noHtml, tableMarkup: MARKUP, newKey: key }).reason, 'renderer-cannot-draw');
  });
  test('refused: bullets when the renderer draws no lists, links when it draws no link, headings it cannot draw', () => {
    const noLists = rendererCapabilities('const c = { block: { h2: 1, normal: 1 }, marks: { link: 1 } };');
    assert.equal(sectionToBlocks({ heading: 'H', body: '- a' }, { capabilities: noLists, newKey: key }).reason, 'renderer-cannot-draw');
    const noLink = rendererCapabilities('const c = { block: { h2: 1, normal: 1 }, marks: { strong: 1 } };');
    assert.equal(sectionToBlocks({ heading: 'H', body: 'see [x](/y)' }, { capabilities: noLink, newKey: key }).reason, 'renderer-cannot-draw');
    const noH2 = rendererCapabilities('const c = { block: { normal: 1 } };');
    assert.equal(sectionToBlocks({ heading: 'H', body: 'b' }, { capabilities: noH2, newKey: key }).reason, 'renderer-cannot-draw');
  });
  test('a section with no heading is not ready', () => assert.equal(sectionToBlocks({ heading: ' ', body: 'x' }, { capabilities: CAPS, newKey: key }).reason, 'draft-not-ready'));
  test('AI-written blocks carry a recognisable key in the site\'s 12-character shape', () => {
    const k = newAiKey();
    assert.equal(k.length, 12); assert.ok(isAiKey(k)); assert.ok(!isAiKey('83d3f6bd3d25'));
  });
});

describe('Q&A: question headings with short answers in the body, not a FAQ box', () => {
  const items = [{ question: 'How much is the fee?', answer: 'About **£17,950** a year, see [the university](https://x.test/fees).' }, { question: 'Can I work?', answer: 'Yes, part-time.' }];
  test('each question is an h3 heading and each answer a paragraph, with no section heading of its own', () => {
    const r = qaToBlocks(items, { capabilities: CAPS, newKey: key });
    assert.equal(r.ok, true);
    assert.deepEqual(r.blocks.map((b) => b.style), ['h3', 'normal', 'h3', 'normal']);
    assert.equal(r.blocks[0].children[0].text, 'How much is the fee?');
    assert.equal(r.blocks[1].markDefs[0].href, 'https://x.test/fees');
  });
  test('a question the post already has as a heading is not added again', () => {
    const r = qaToBlocks(items, { capabilities: CAPS, existing: new Set([normalizeHeading('how much is the fee')]), newKey: key });
    assert.deepEqual(r.blocks.map((b) => b.children[0].text).filter((t) => t.endsWith('?')), ['Can I work?']);
    assert.deepEqual(r.skipped, ['How much is the fee?']);
  });
  test('refused when the renderer draws no h3 or no links, or an item is incomplete', () => {
    assert.equal(qaToBlocks(items, { capabilities: rendererCapabilities('const c = { block: { normal: 1 } };'), newKey: key }).reason, 'renderer-cannot-draw');
    assert.equal(qaToBlocks(items, { capabilities: rendererCapabilities('const c = { block: { h3: 1, normal: 1 }, marks: { strong: 1 } };'), newKey: key }).reason, 'renderer-cannot-draw');
    assert.equal(qaToBlocks([{ question: 'q?', answer: '' }], { capabilities: CAPS, newKey: key }).reason, 'draft-not-ready');
  });
});

describe('where it goes: above the closing part and above the call to action', () => {
  const body = (n) => Array.from({ length: n }, (_, i) => para(`p${i}`));
  test('a post with no closing part and no CTA: at the end', () => assert.equal(insertionIndex(body(8)), 8));
  test('before a "Conclusion" or "Related reading" heading in the second half', () => {
    const c = [...body(6), para('Conclusion', 'h2'), para('wrap up')];
    assert.equal(insertionIndex(c), 6);
  });
  test('a closing-looking heading in the first half is just a section, not the end', () => {
    const c = [para('Sources of income', 'h2'), ...body(8)];
    assert.equal(insertionIndex(c), 9);
  });
  test('always above the call to action', () => {
    const c = [...body(5), cta(), cta()];
    assert.equal(ctaStart(c), 5);
    assert.equal(insertionIndex(c), 5);
  });
  test('references ("sources") go after the closing part but still above the CTA', () => {
    const c = [...body(6), para('Related reading', 'h2'), para('link'), cta()];
    assert.equal(insertionIndex(c, 'body'), 6);
    assert.equal(insertionIndex(c, 'sources'), 8);
  });
  test('headings already in the post are known, so none is added twice', () => {
    assert.deepEqual([...existingHeadings([para('Visa Costs!', 'h2'), para('x')])], ['visa costs']);
    assert.equal(normalizeHeading('  Visa  costs? '), 'visa costs');
  });
});

describe('a call to action versus an article that contains one (found on real Admizz posts)', () => {
  const article = { _key: 'a', _type: 'rawHtml', html: `<section><h2>Guide</h2><p>${'long text '.repeat(300)}</p><div class="cta-banner">Book</div></section>` };
  test('a small standalone cta-banner is a CTA; a whole article that merely contains one is not', () => {
    assert.equal(isCtaBlock({ _type: 'rawHtml', html: '<div class="cta-banner">Book</div>' }), true);
    assert.equal(isCtaBlock(article), false);
    assert.equal(isCtaBlock({ _type: 'rawHtml', html: '<div class="cta-banner"><h2>Big</h2></div>' }), false);
    assert.equal(isCtaBlock(para('x')), false);
  });
  test('such an article is not mistaken for the CTA, so nothing is inserted above the whole article', () => {
    assert.equal(ctaStart([article]), 1);
    assert.equal(insertionIndex([article]), 1);
  });
  test('a post that is mostly raw HTML is recognised, a normal post is not', () => {
    assert.equal(rawHtmlDominates([article]), true);
    assert.equal(rawHtmlDominates([para('a long normal paragraph of body text'), cta()]), false);
    assert.equal(rawHtmlDominates([para('A normal paragraph of article text. '.repeat(20)), { _type: 'rawHtml', html: `<table>${'<tr><td>cell text</td></tr>'.repeat(3)}</table>` }]), false, 'a table block inside a normal post is fine');
  });
});

describe('the safety proof', () => {
  const post = { _id: 'p1', title: 'T', content: [para('a'), para('b'), para('c')], seo: { x: 1 } };
  const before = canonicalJson(post);
  const ins = [para('NEW', 'h2'), para('new body')];
  const good = canonicalJson({ ...post, content: [post.content[0], ...ins, post.content[1], post.content[2]] });
  test('canonical JSON round-trips; anything else is not edited byte-for-byte', () => {
    assert.equal(isCanonicalJson(before), true);
    assert.equal(isCanonicalJson(JSON.stringify(post)), false);
    assert.equal(isCanonicalJson('not json'), false);
  });
  test('an edit that only inserts the intended blocks passes', () => assert.deepEqual(verifyBodyEdit(before, good, { index: 1, inserted: ins }), { ok: true }));
  test('every kind of collateral change is caught', () => {
    const edits = {
      'another field': canonicalJson({ ...post, title: 'T2', content: [post.content[0], ...ins, post.content[1], post.content[2]] }),
      'field order': canonicalJson({ content: [post.content[0], ...ins, post.content[1], post.content[2]], ...Object.fromEntries(Object.entries(post).filter(([k]) => k !== 'content')) }),
      'a block before': canonicalJson({ ...post, content: [para('CHANGED'), ...ins, post.content[1], post.content[2]] }),
      'a block after': canonicalJson({ ...post, content: [post.content[0], ...ins, post.content[1], para('CHANGED')] }),
      'other inserted blocks': canonicalJson({ ...post, content: [post.content[0], para('SOMETHING ELSE'), para('x'), post.content[1], post.content[2]] }),
      'a block removed': canonicalJson({ ...post, content: [...ins, post.content[1], post.content[2]] }),
    };
    for (const [what, text] of Object.entries(edits)) assert.equal(verifyBodyEdit(before, text, { index: 1, inserted: ins }).ok, false, what);
  });
});
