import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeChange, identifyTarget, isDataReady, meta, SUPPORTED_ACTIONS } from './portable-text-post-body.js';
import { getAdapter, listAdapterMeta } from './registry.js';
import { canonicalJson, isAiKey } from './lib/portable-text-body.js';

const RENDERER = `const components = {
  block: { h2: () => null, h3: () => null, normal: () => null, blockquote: () => null },
  marks: { strong: () => null, em: () => null, link: () => null },
  list: { bullet: () => null, number: () => null }, listItem: { bullet: () => null, number: () => null },
  types: { image: () => null, rawHtml: () => null },
};`;
const blk = (text, style = 'normal', k = text.slice(0, 6).padEnd(12, '0')) => ({ _key: k, _type: 'block', children: [{ _key: `${k}s`, _type: 'span', marks: [], text }], markDefs: [], style });
const POST = {
  _id: 'wp-post-9', _type: 'post', title: 'Study in the UK', slug: { _type: 'slug', current: 'study-uk' }, excerpt: 'x',
  content: [blk('Intro text'), blk('Costs', 'h2'), blk('Fees are high'), blk('Conclusion', 'h2'), blk('Thanks'), { _key: 'ctactactacta', _type: 'rawHtml', html: '<div class="cta-banner">Book</div>' }],
  faqItems: [{ question: 'q', answer: 'a' }], seo: { metaTitle: 'T' },
};
const files = { 'src/content/blog/posts/study-uk.json': canonicalJson(POST), 'src/components/PortableTextRenderer.tsx': RENDERER };
const fetchFile = async (_s, path) => (path in files ? { content: files[path] } : null);

const CFG = { id: 'portable-text-post-body', contentFile: 'src/content/blog/posts/{key}.json', urlPattern: '^/([^/]+)/?$', tableMarkup: { wrapperClass: 'table-scroll', tableClass: 'elig-table' } };
const site = (cfg = CFG) => ({ id: 8862, url_file_map: { patterns: [{ match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx', adapters: { 'expand-content': cfg } }] } });
const draft = (page, content = {}, action_type = 'expand-content') => ({
  action_type, content: { page: `https://admizzeducation.com${page}`, focus: 'general', sections: [{ heading: 'Living costs', body: 'Budget **carefully**.\n\n- rent\n- food' }], ...content },
});

function describe_rich() {
  const richHtml = (ids = ['s1', 's2'], style = '<style>.elig-table{} .table-scroll{}</style>', body = '') => `${style}<div class="container">${ids.map((id, i) => `<section class="section" id="${id}"><h2>Heading ${i + 1}</h2><p>text</p>${i === 0 ? '<ul><li>a</li></ul>' : ''}</section>`).join('')}${body}<div class="cta-banner"><h2>Book</h2></div><section class="section" id="faq"><h2>FAQ</h2></section></div>`;
  const richFiles = (html) => ({ ...files, 'src/content/blog/posts/study-uk.json': canonicalJson({ ...POST, content: [{ _key: 'rawrawrawraw', _type: 'rawHtml', html }] }) });
  const read = (f) => async (_s, p) => (p in f ? { content: f[p] } : null);
  const longHtml = (ids, style) => richHtml(ids, style, `<section class="section" id="long"><p>${'long text '.repeat(200)}</p></section>`);

  test('a post that is one raw-HTML page is edited in its OWN markup, as a new section directly above its call to action', async () => {
    const r = await computeChange(site(), draft('/study-uk'), read(richFiles(longHtml())), 'main');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.filePath, 'src/content/blog/posts/study-uk.json');
    const html = JSON.parse(r.newContent).content[0].html;
    const i = html.search(/<section class="section" id="[^"]+"><h2>Living costs<\/h2>/);
    assert.ok(i > 0 && html.indexOf('<div class="cta-banner">') > i, 'the new section sits above the call to action');
    assert.match(html, /<ul><li>rent<\/li><li>food<\/li><\/ul>/, 'the page already uses lists, so one is written');
    for (const k of ['_id', 'title', 'seo', 'faqItems']) assert.deepEqual(JSON.parse(r.newContent)[k], POST[k], k);
  });
  test('a comparison table is written with the page\'s own CSS classes when its CSS defines them, even if it has no table yet', async () => {
    const r = await computeChange(site(), draft('/study-uk', { sections: [{ heading: 'Compare', body: 'Lead.', table: [{ a: '1', b: '2' }] }] }), read(richFiles(longHtml())), 'main');
    assert.equal(r.ok, true, r.error);
    assert.match(JSON.parse(r.newContent).content[0].html, /<div class="table-scroll"><table class="elig-table">/);
  });
  const CSS_SRC = 'export const RICH_POST_CSS = `\n.table-scroll{width:100%;overflow-x:auto}\n.elig-table{border-collapse:collapse}\n.elig-table th{color:#fff}\n`;';
  const withCssFile = (f) => ({ ...f, 'src/components/lib/blog-rich-styles.ts': CSS_SRC });
  const tableDraft = () => draft('/study-uk', { sections: [{ heading: 'Compare', body: 'Lead.', table: [{ a: '1', b: '2' }] }] });

  test('a table on a page whose own CSS lacks the site\'s table classes: the site\'s own rules are copied into the page\'s style', async () => {
    const f = withCssFile(richFiles(longHtml(['s1', 's2'], '<style>.section{margin:0}</style>')));
    const cfg = { ...CFG, tableCssFile: 'src/components/lib/blog-rich-styles.ts' };
    const r = await computeChange(site(cfg), tableDraft(), read(f), 'main');
    assert.equal(r.ok, true, r.error);
    const html = JSON.parse(r.newContent).content[0].html;
    assert.match(html, /<style>\.section\{margin:0\}\n\.table-scroll\{width:100%;overflow-x:auto\}\n\.elig-table\{border-collapse:collapse\}\n\.elig-table th\{color:#fff\}\n<\/style>/);
    assert.match(html, /<div class="table-scroll"><table class="elig-table">/);
    assert.match(r.changedRegions[0].after, /table rules added/);
  });
  test('without the site\'s stylesheet, or with no style block to add to, the table is still refused: nothing is invented', async () => {
    const noFile = await computeChange(site(CFG), tableDraft(), read(richFiles(longHtml(['s1', 's2'], '<style>.section{}</style>'))), 'main');
    assert.deepEqual([noFile.ok, noFile.reason], [false, 'no-table-design']);
    const missing = await computeChange(site({ ...CFG, tableCssFile: 'src/nope.ts' }), tableDraft(), read(richFiles(longHtml(['s1', 's2'], '<style>.section{}</style>'))), 'main');
    assert.deepEqual([missing.ok, missing.reason], [false, 'no-table-design']);
  });
  test('a page whose own CSS already defines the classes gets no extra CSS', async () => {
    const f = withCssFile(richFiles(longHtml()));
    const r = await computeChange(site({ ...CFG, tableCssFile: 'src/components/lib/blog-rich-styles.ts' }), tableDraft(), read(f), 'main');
    assert.equal(r.ok, true, r.error);
    assert.equal((JSON.parse(r.newContent).content[0].html.match(/\.elig-table\{/g) || []).length, 1);
  });
  test('a Q&A on a raw-HTML page: each question is a section with an h2 when the page has no h3, an h3 when it has them', async () => {
    const qa = (page) => ({ action_type: 'qa-content', content: { page, items: [{ question: 'How much?', answer: 'It depends.' }] } });
    const qaSite = { id: 8862, url_file_map: { patterns: [{ match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx', adapters: { 'qa-content': CFG } }] } };
    const h2 = await computeChange(qaSite, qa('https://admizzeducation.com/study-uk'), read(richFiles(longHtml())), 'main');
    assert.equal(h2.ok, true, h2.error);
    assert.match(JSON.parse(h2.newContent).content[0].html, /<section class="section" id="how-much"><h2>How much\?<\/h2><p>It depends\.<\/p><\/section>/);
    const withH3 = longHtml().replace('<p>text</p>', '<h3>Existing</h3><p>text</p>');
    const h3 = await computeChange(qaSite, qa('https://admizzeducation.com/study-uk'), read(richFiles(withH3)), 'main');
    assert.equal(h3.ok, true, h3.error);
    assert.match(JSON.parse(h3.newContent).content[0].html, /<h3>How much\?<\/h3><p>It depends\.<\/p>/);
  });
  test('named-section pages get a unique id from the heading, and a heading the page already has is not repeated', async () => {
    const f = richFiles(longHtml(['intro', 'courses']));
    const r = await computeChange(site(), draft('/study-uk', { sections: [{ heading: 'Heading 1', body: 'dup' }, { heading: 'Visa costs', body: 'x' }] }), read(f), 'main');
    assert.equal(r.ok, true, r.error);
    const html = JSON.parse(r.newContent).content[0].html;
    assert.match(html, /<section class="section" id="visa-costs"><h2>Visa costs<\/h2>/);
    assert.equal((html.match(/<h2>Heading 1<\/h2>/g) || []).length, 1);
    assert.deepEqual(r.skippedExisting, ['Heading 1']);
  });
}

describe('portable-text-post-body: expand-content for a post served by the shared [slug] template', () => {
  test('it is a registered adapter and writes expand-content and refresh-content', async () => {
    assert.equal(meta.id, 'portable-text-post-body');
    assert.ok((await listAdapterMeta()).some((m) => m.id === 'portable-text-post-body'));
    assert.equal((await getAdapter('portable-text-post-body')).meta.id, 'portable-text-post-body');
    assert.deepEqual(SUPPORTED_ACTIONS, ['expand-content', 'refresh-content', 'qa-content']);
  });

  test('writes the post\'s own file, inserts above the closing part, changes nothing else', async () => {
    const r = await computeChange(site(), draft('/study-uk'), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.filePath, 'src/content/blog/posts/study-uk.json', 'never the shared template');
    const after = JSON.parse(r.newContent);
    assert.deepEqual(after.content.map((b) => b._type === 'rawHtml' ? 'CTA' : `${b.style}${b.listItem ? ':' + b.listItem : ''}:${b.children?.[0]?.text.slice(0, 12)}`), [
      'normal:Intro text', 'h2:Costs', 'normal:Fees are hig', 'h2:Living costs', 'normal:Budget ', 'normal:bullet:rent', 'normal:bullet:food', 'h2:Conclusion', 'normal:Thanks', 'CTA',
    ]);
    for (const k of ['_id', 'title', 'slug', 'excerpt', 'faqItems', 'seo']) assert.deepEqual(after[k], POST[k], k);
    assert.ok(after.content.filter((b) => isAiKey(b._key)).length >= 4, 'every added block is recognisable as AI-written');
    assert.equal(r.renderMode, 'visible');
    assert.match(r.changedRegions[0].after, /Living costs/);
  });

  test('a comparison table is written as the site\'s own table markup', async () => {
    const r = await computeChange(site(), draft('/study-uk', { sections: [{ heading: 'UK vs USA', body: 'Lead.', table: [{ feature: 'Fees', uk: '£', usa: '$' }] }] }), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    const tableBlock = JSON.parse(r.newContent).content.find((b) => b._type === 'rawHtml' && b.html.includes('<table'));
    assert.match(tableBlock.html, /^<div class="table-scroll"><table class="elig-table"><thead><tr><th>Feature<\/th>/);
  });

  test('citations go to the end, still above the call to action', async () => {
    const r = await computeChange(site(), draft('/study-uk', { focus: 'external-citations', sections: [{ heading: 'Sources', body: '- [GOV.UK](https://www.gov.uk/student-visa)' }] }), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    const c = JSON.parse(r.newContent).content;
    assert.equal(c.at(-1)._type, 'rawHtml', 'the CTA is still last');
    assert.equal(c.at(-2).children[0].marks.length, 1, 'the source link is just before it');
  });

  test('a section the post already has is not added again; nothing left to add is "already satisfied"', async () => {
    const r = await computeChange(site(), draft('/study-uk', { sections: [{ heading: 'costs', body: 'x' }] }), fetchFile, 'main');
    assert.equal(r.ok, false); assert.equal(r.reason, 'already-satisfied');
  });

  test('a table when no table design of the site is configured is refused, never invented', async () => {
    const { tableMarkup, ...noTables } = CFG;
    const r = await computeChange(site(noTables), draft('/study-uk', { sections: [{ heading: 'Compare', body: 'b', table: [{ a: '1' }] }] }), fetchFile, 'main');
    assert.deepEqual([r.ok, r.reason], [false, 'no-table-design']);
  });

  test('a renderer that cannot draw what the draft needs refuses it', async () => {
    const bare = { ...files, 'src/components/PortableTextRenderer.tsx': 'const c = { block: { normal: () => null } };' };
    const r = await computeChange(site(), draft('/study-uk'), async (_s, p) => (p in bare ? { content: bare[p] } : null), 'main');
    assert.deepEqual([r.ok, r.reason], [false, 'renderer-cannot-draw']);
  });

  test('a post that does not exist is never created', async () => {
    const r = await computeChange(site(), draft('/no-such-post'), fetchFile, 'main');
    assert.deepEqual([r.ok, r.reason], [false, 'target-not-identified']);
  });

  test('a file that is not canonical JSON is not edited (a byte-exact edit could not be proven)', async () => {
    const odd = { ...files, 'src/content/blog/posts/study-uk.json': JSON.stringify(POST) };
    const r = await computeChange(site(), draft('/study-uk'), async (_s, p) => (p in odd ? { content: odd[p] } : null), 'main');
    assert.deepEqual([r.ok, r.reason], [false, 'no-insertion-marker']);
  });

  describe_rich();
  test('a post stored as one raw-HTML page with no recognisable structure is not edited: new blocks would not match its design', async () => {
    const rawPost = { ...POST, content: [{ _key: 'rawrawrawraw', _type: 'rawHtml', html: `<section><h2>Guide</h2><p>${'long text '.repeat(300)}</p><div class="cta-banner">Book</div></section>` }] };
    const f = { ...files, 'src/content/blog/posts/study-uk.json': canonicalJson(rawPost) };
    const r = await computeChange(site(), draft('/study-uk'), async (_s, p) => (p in f ? { content: f[p] } : null), 'main');
    assert.deepEqual([r.ok, r.reason], [false, 'no-insertion-marker']);
    assert.match(r.error, /raw HTML/);
  });

  test('a refreshed section (one "Updated" section) is written the same way, from the refresh-content config', async () => {
    const refreshSite = { id: 8862, url_file_map: { patterns: [{ match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx', adapters: { 'refresh-content': CFG } }] } };
    const r = await computeChange(refreshSite, draft('/study-uk', { focus: 'content-refresh', sections: [{ heading: 'Updated for 2027', body: 'The fee changed.' }] }, 'refresh-content'), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.filePath, 'src/content/blog/posts/study-uk.json');
    assert.ok(JSON.parse(r.newContent).content.some((b) => b.children?.[0]?.text === 'Updated for 2027'));
  });

  test('a Q&A is written as question headings in the body, above the closing part, and never touches the FAQ items', async () => {
    const qaSite = { id: 8862, url_file_map: { patterns: [{ match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx', adapters: { 'qa-content': CFG } }] } };
    const d = { action_type: 'qa-content', content: { page: 'https://admizzeducation.com/study-uk', query: 'uk fees', items: [{ question: 'How much does it cost?', answer: 'It depends on the course.' }], schemaJsonLd: {} } };
    const r = await computeChange(qaSite, d, fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    const after = JSON.parse(r.newContent);
    assert.deepEqual(after.content.map((b) => b.children?.[0]?.text).filter(Boolean).slice(2, 6), ['Fees are high', 'How much does it cost?', 'It depends on the course.', 'Conclusion']);
    assert.deepEqual(after.faqItems, POST.faqItems, 'the FAQ is a separate slot and is left exactly as it was');
    assert.equal(after.content.find((b) => b.children?.[0]?.text === 'How much does it cost?').style, 'h3');
  });

  test('a Q&A the post already answers as a heading is not added again', async () => {
    const qaSite = { id: 8862, url_file_map: { patterns: [{ match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx', adapters: { 'qa-content': CFG } }] } };
    const withQ = { ...POST, content: [...POST.content.slice(0, 3), blk('Is it costly?', 'h3'), blk('Yes.'), ...POST.content.slice(3)] };
    const f = { ...files, 'src/content/blog/posts/study-uk.json': canonicalJson(withQ) };
    const r = await computeChange(qaSite, { action_type: 'qa-content', content: { page: 'https://admizzeducation.com/study-uk', items: [{ question: 'Is it costly?', answer: 'x' }] } }, async (_s, p) => (p in f ? { content: f[p] } : null), 'main');
    assert.deepEqual([r.ok, r.reason], [false, 'already-satisfied']);
  });

  test('other action types, a missing config and an empty draft are refused with a reason', async () => {
    assert.equal((await computeChange(site(), draft('/study-uk', {}, 'meta-title'), fetchFile, 'main')).reason, 'unsupported-action');
    assert.equal((await computeChange({ id: 1, url_file_map: {} }, draft('/study-uk'), fetchFile, 'main')).reason, 'no-file-mapping');
    assert.equal((await computeChange(site(), draft('/study-uk', { sections: [] }), fetchFile, 'main')).reason, 'draft-not-ready');
  });

  test('the readiness check the gate uses agrees with the real answer', async () => {
    assert.equal(await isDataReady(site(), 'https://admizzeducation.com/study-uk', CFG, fetchFile, 'main'), true);
    assert.equal(await isDataReady(site(), 'https://admizzeducation.com/nope', CFG, fetchFile, 'main'), false);
    assert.equal((await identifyTarget(site(), 'https://admizzeducation.com/study-uk', { id: 'portable-text-post-body' }, fetchFile, 'main')).reason, 'invalid-config');
  });
});
