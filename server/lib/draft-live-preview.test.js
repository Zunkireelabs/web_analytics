import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { blocksOf, renderBodyHtml, buildPreviewDocument, buildOptionDocument, readBlock, writeBlock, rewriteBlock, getArticleShell, clearShellCache, warmArticleShells, referenceUrlsFor } from './draft-live-preview.js';

const CONTENT = {
  title: 'Scholarship Tips',
  quickAnswer: 'Answer the prompt and give real examples.',
  sections: [
    { heading: 'Start with the prompt', body: 'Read the **prompt** first.\n\n| Term | Meaning |\n| --- | --- |\n| A | b |' },
    { heading: 'Be honest', body: 'Keep it true.' },
  ],
  faqItems: [{ question: 'How long?', answer: 'About 500 words.' }, { question: 'Who reads it?', answer: 'A panel.' }],
  sources: [{ label: 'GOV.UK', url: 'https://www.gov.uk/x' }],
};
const SHELL = {
  shellHtml: '<!DOCTYPE html><html><head><title>Old</title><base href="https://site.example/blog/x/"></head><body><header>Site header</header><h1>Old title</h1><article><div id="__draft_body__"></div></article><aside>Related articles</aside><footer>Footer</footer></body></html>',
  classFor: { p: { cls: 'site-p', style: '' }, h2: { cls: 'site-h2', style: 'margin-top:2rem' }, table: { cls: 'site-table', style: '' } },
  faq: { wrapper: '<div class="faq-box"><h3 class="faq-h">Frequently asked questions</h3>{{ROWS}}</div>', row: '<div class="faq-row"><b>{{QUESTION}}</b><p>{{ANSWER}}</p></div>' },
};

describe('the draft as blocks', () => {
  test('quick answer, sections, FAQ items and sources, in reading order; sources are not editable', () => {
    const b = blocksOf(CONTENT);
    assert.deepEqual(b.map((x) => x.id), ['quick', 's:0', 's:1', 'faq:0', 'faq:1', 'sources']);
    assert.equal(b.find((x) => x.id === 'sources').editable, false);
    assert.equal(b.find((x) => x.id === 's:1').value.heading, 'Be honest');
  });
});

describe('the body in the site\'s own design', () => {
  const html = renderBodyHtml(CONTENT, SHELL);
  test('everything is there: short answer, sections, the table, the FAQ answers and the sources', () => {
    assert.match(html, /Answer the prompt and give real examples\./);
    assert.match(html, /<table/);
    assert.match(html, /About 500 words\./);
    assert.match(html, /<a href="https:\/\/www\.gov\.uk\/x"/);
  });
  test('the site\'s own classes are on the draft\'s elements, and the FAQ uses the site\'s own FAQ design', () => {
    assert.match(html, /<h2 class="site-h2" style="margin-top:2rem">Start with the prompt<\/h2>/);
    assert.match(html, /<table class="site-table"/);
    assert.match(html, /<div class="faq-box"><h3 class="faq-h">Frequently asked questions<\/h3>/);
    assert.match(html, /<div class="faq-row"><b>How long\?<\/b><p>About 500 words\.<\/p><\/div>/);
  });
  test('every block can be clicked: each carries its id', () => {
    for (const id of ['quick', 's:0', 's:1', 'faq:0', 'faq:1', 'sources']) assert.ok(html.includes(`data-block-id="${id}"`), id);
  });
  test('without a learned FAQ design a plain FAQ section is drawn, never nothing', () => {
    const plain = renderBodyHtml(CONTENT, { classFor: {} });
    assert.match(plain, /Frequently asked questions/);
    assert.match(plain, /Who reads it\?/);
  });
  test('text from the draft is escaped, not run', () => {
    const evil = renderBodyHtml({ quickAnswer: '<img src=x onerror=alert(1)>', sections: [] }, { classFor: {} });
    assert.ok(!/<img src=x/.test(evil));
  });
});

describe('the page', () => {
  test('the site\'s page with the draft in the hole, the title replaced, and the click script; the header, related articles and footer stay', () => {
    const r = buildPreviewDocument(CONTENT, SHELL);
    assert.equal(r.ok, true);
    assert.match(r.html, /Site header/);
    assert.match(r.html, /Related articles/);
    assert.match(r.html, /Footer/);
    assert.match(r.html, /<h1>Scholarship Tips<\/h1>/);
    assert.match(r.html, /<title>Scholarship Tips<\/title>/);
    assert.ok(!r.html.includes('__draft_body__'));
    assert.match(r.html, /draft-block-click/);
  });
  test('a capture with no hole is reported, not faked', () => {
    assert.equal(buildPreviewDocument(CONTENT, { shellHtml: '<html><body></body></html>' }).ok, false);
  });
});

describe('the hero and the stylesheet', () => {
  const HERO = { referenceUrl: 'https://site.example/blog/ref/', shellHtml: '<!DOCTYPE html><html><head><link rel="stylesheet" crossorigin integrity="sha384-x" href="/a.css"></head><body><img class="logo" src="/logo.png"><h1>Ref title</h1><p class="lede">The reference article subtitle that is not ours.</p><picture><source srcset="/ref.webp"><img src="/ref.jpg" srcset="/ref-2x.jpg 2x" alt="ref"></picture><article><div id="__draft_body__"></div></article></body></html>', classFor: {} };
  test('the stylesheet loses crossorigin and integrity so it draws inside the frame', () => {
    const r = buildPreviewDocument({ title: 'T', sections: [{ heading: 'H', body: 'b' }] }, HERO);
    assert.match(r.html, /<link rel="stylesheet" href="\/a\.css">/);
  });
  test('the subtitle and the cover are the draft\'s own, never the reference article\'s; the logo is left alone', () => {
    const r = buildPreviewDocument({ title: 'T', metaDescription: 'This post explains the thing.', featuredImage: { url: '/images/blog/mine.webp', alt: 'Mine' }, sections: [{ heading: 'H', body: 'b' }] }, HERO);
    assert.match(r.html, /This post explains the thing\./);
    assert.ok(!r.html.includes('reference article subtitle'));
    assert.match(r.html, /src="https:\/\/site\.example\/images\/blog\/mine\.webp"/);
    assert.ok(!r.html.includes('ref.jpg') && !r.html.includes('ref.webp') && !r.html.includes('ref-2x'));
    assert.match(r.html, /<img class="logo" src="\/logo\.png">/);
  });
  test('the lede is found wherever it sits after the title, and the reference title in the breadcrumb becomes the draft\'s', () => {
    const shell = { referenceUrl: 'https://s.example/b/', refTitle: 'Ref title', shellHtml: '<html><body><nav>Home / Blog / <span>Ref title</span></nav><header><div><h1>Ref title</h1></div><div><p>The reference lead-in sentence that is not ours at all.</p></div></header><div id="__draft_body__"></div></body></html>', classFor: {} };
    const r = buildPreviewDocument({ title: 'My post', metaDescription: 'Our own description of the post.', sections: [{ heading: 'H', body: 'b' }] }, shell);
    assert.match(r.html, /Our own description of the post\./);
    assert.ok(!r.html.includes('reference lead-in'));
    assert.match(r.html, /Home \/ Blog \/ <span>My post<\/span>/);
    assert.ok(!r.html.includes('Ref title'));
  });
  test('a cover drawn as a box with an inline SVG is the draft\'s cover, or hidden when the draft has none', () => {
    const shell = { referenceUrl: 'https://s.example/b/', refTitle: 'R', shellHtml: '<html><body><h1>R</h1><div class="a-cover-wrap"><div class="post__cover"><svg><circle/></svg></div></div><p>x</p><div id="__draft_body__"></div></body></html>', classFor: {} };
    const own = buildPreviewDocument({ title: 'T', featuredImage: { url: '/img/mine.png', alt: 'Mine' }, sections: [{ heading: 'H', body: 'b' }] }, shell).html;
    assert.match(own, /<div class="a-cover-wrap"><img src="https:\/\/s\.example\/img\/mine\.png" alt="Mine"/);
    assert.ok(!own.includes('<svg'));
    const none = buildPreviewDocument({ title: 'T', sections: [{ heading: 'H', body: 'b' }] }, shell).html;
    assert.match(none, /<div class="a-cover-wrap" style="display:none">/);
  });
  test('a draft with no cover image hides the reference\'s picture instead of showing another post\'s', () => {
    const r = buildPreviewDocument({ title: 'T', sections: [{ heading: 'H', body: 'b' }] }, HERO);
    assert.match(r.html, /display:none/);
  });
});

describe('editing one block', () => {
  test('writeBlock changes only that block and leaves the input untouched', () => {
    const next = writeBlock(CONTENT, 'faq:1', { question: 'Who reads it?', answer: 'A panel of three.' });
    assert.equal(next.faqItems[1].answer, 'A panel of three.');
    assert.equal(next.faqItems[0].answer, 'About 500 words.');
    assert.equal(CONTENT.faqItems[1].answer, 'A panel.');
    assert.equal(writeBlock(CONTENT, 'quick', ' New. ').quickAnswer, 'New.');
    assert.equal(writeBlock(CONTENT, 's:0', { heading: 'H', body: 'B' }).sections[0].heading, 'H');
  });
  test('an empty or unknown block is refused', () => {
    assert.throws(() => writeBlock(CONTENT, 'quick', ''), /cannot be empty/);
    assert.throws(() => writeBlock(CONTENT, 's:9', { body: 'x' }), /no longer exists/);
    assert.throws(() => writeBlock(CONTENT, 'sources', []), /cannot be edited/);
    assert.throws(() => writeBlock(CONTENT, 'faq:0', { question: 'q', answer: '' }), /both a question and an answer/);
  });
  test('rewriteBlock sends only that block and the instruction, and returns the model\'s new value', async () => {
    let seen;
    const callJson = async (system, user) => { seen = { system, user }; return { heading: 'Be honest', body: 'Keep it true and short.' }; };
    const out = await rewriteBlock({ block: readBlock(CONTENT, 's:1'), instruction: 'make it shorter', topic: 'Scholarship Tips', callJson });
    assert.deepEqual(out, { heading: 'Be honest', body: 'Keep it true and short.' });
    assert.match(seen.user, /make it shorter/);
    assert.match(seen.user, /Keep it true\./);
    assert.ok(!seen.user.includes('About 500 words'), 'other blocks are not sent');
    assert.match(seen.system, /Never add a statistic/);
  });
  test('a rewrite that comes back empty is refused', async () => {
    await assert.rejects(() => rewriteBlock({ block: readBlock(CONTENT, 'quick'), instruction: 'x', callJson: async () => ({ text: '  ' }) }), /came back empty/);
  });
});

describe('the captured page is kept', () => {
  test('captured once and shared; a failed capture is not kept', async () => {
    clearShellCache();
    let n = 0;
    const capture = async () => { n++; return { ok: true, shellHtml: 'x' }; };
    await Promise.all([getArticleShell(1, 'https://a/', { capture }), getArticleShell(1, 'https://a/', { capture })]);
    await getArticleShell(1, 'https://a/', { capture });
    assert.equal(n, 1);
    let m = 0;
    const failing = async () => { m++; return { ok: false, reason: 'unreachable' }; };
    await getArticleShell(2, 'https://b/', { capture: failing });
    await getArticleShell(2, 'https://b/', { capture: failing });
    assert.equal(m, 2);
  });
});

describe('kept warm ahead of time', () => {
  test('a forced refresh keeps serving the good capture until the new one succeeds, and a failed refresh leaves it in place', async () => {
    clearShellCache();
    await getArticleShell(1, 'https://w/', { capture: async () => ({ ok: true, shellHtml: 'old' }) });
    const failed = await getArticleShell(1, 'https://w/', { force: true, capture: async () => ({ ok: false, reason: 'unreachable' }) });
    assert.equal(failed.shellHtml, 'old');
    const kept = await getArticleShell(1, 'https://w/', { capture: async () => { throw new Error('must not capture'); } });
    assert.equal(kept.shellHtml, 'old');
    const fresh = await getArticleShell(1, 'https://w/', { force: true, capture: async () => ({ ok: true, shellHtml: 'new' }) });
    assert.equal(fresh.shellHtml, 'new');
    assert.equal((await getArticleShell(1, 'https://w/', { capture: async () => { throw new Error('no'); } })).shellHtml, 'new');
  });
  test('every site\'s reference pages are captured one after another, a failure on one does not stop the rest, and it never throws', async () => {
    const order = [];
    const getShell = async (id, url) => { order.push(`${id}:${url}`); if (id === 2) throw new Error('slow site down'); return { ok: true }; };
    const pick = (_p, role) => (role === 'inline-article' ? 'https://s/blog/a/' : 'https://s/landing/');
    const out = await warmArticleShells([{ id: 1 }, { id: 2 }, { id: 3 }], { getProfile: () => ({}), pick, getShell, log: { log() {} } });
    assert.deepEqual(order, ['1:https://s/blog/a/', '1:https://s/landing/', '2:https://s/blog/a/', '2:https://s/landing/', '3:https://s/blog/a/', '3:https://s/landing/']);
    assert.equal(out.filter((d) => d.ok).length, 4);
    assert.equal(out.filter((d) => !d.ok).length, 2);
  });
  test('a site with no captured pages yet is skipped quietly; the same page for blog and landing is captured once', () => {
    assert.deepEqual(referenceUrlsFor({}, () => null), []);
    assert.deepEqual(referenceUrlsFor({}, () => 'https://s/x/'), ['https://s/x/']);
  });
});

describe('an idea\'s option: parts a person can click', () => {
  test('every top-level part has an id and a plain label, the page carries the click script, and the parts are listed', () => {
    const shell = { referenceUrl: 'https://s.example/b/', refTitle: 'R', shellHtml: '<html><body><h1>R</h1><div id="__draft_body__"></div></body></html>', classFor: {} };
    const r = buildOptionDocument({ bodyHtml: '<p>An introduction to the guide and who it is for.</p><h2>Why it matters</h2><p>A short useful paragraph.</p><ul><li>One</li><li>Two</li></ul><p></p>', title: 'T' }, shell);
    assert.deepEqual(r.parts.map((p) => p.id), ['part:0', 'part:1', 'part:2', 'part:3']);
    assert.equal(r.parts[1].label, 'Why it matters');
    assert.match(r.parts[0].label, /^Paragraph: An introduction/);
    assert.match(r.parts[3].label, /^List: /);
    assert.match(r.html, /data-block-id="part:1"/);
    assert.match(r.html, /draft-block-click/);
  });
});

describe('an idea\'s option in the same captured page', () => {
  test('the option\'s sample body in the site\'s page, with the option\'s title and the stylesheet fixed', () => {
    const shell = { referenceUrl: 'https://s.example/b/', refTitle: 'Ref', shellHtml: '<html><head><link rel="stylesheet" crossorigin href="/a.css"></head><body><h1>Ref</h1><div id="__draft_body__"></div><footer>Foot</footer></body></html>', classFor: { p: { cls: 'site-p', style: '' } } };
    const r = buildOptionDocument({ bodyHtml: '<p>Sample paragraph.</p>', title: 'Idea title' }, shell);
    assert.equal(r.ok, true);
    assert.match(r.html, /<h1>Idea title<\/h1>/);
    assert.match(r.html, /<p data-block-id="part:0" data-block-kind="part" class="site-p">Sample paragraph\.<\/p>/);
    assert.match(r.html, /<link rel="stylesheet" href="\/a\.css">/);
    assert.match(r.html, /Foot/);
  });
});

import { writeBlock as writeBlockChecked } from './draft-live-preview.js';
test('a typed value must be plain text of the right shape and a sane length', () => {
  const content = { sections: [{ heading: 'H', body: 'B' }], faqItems: [{ question: 'Q', answer: 'A' }], quickAnswer: 'Q' };
  assert.throws(() => writeBlockChecked(content, 'quick', { a: 1 }), /must be text/);
  assert.throws(() => writeBlockChecked(content, 'quick', ['x']), /must be text/);
  assert.throws(() => writeBlockChecked(content, 's:0', 'just a string'), /heading and some text/);
  assert.throws(() => writeBlockChecked(content, 's:0', { heading: 'H', body: 5 }), /must be text/);
  assert.throws(() => writeBlockChecked(content, 'faq:0', { question: 'Q', answer: 'x'.repeat(13000) }), /too long/);
  assert.equal(writeBlockChecked(content, 'quick', '  New answer  ').quickAnswer, 'New answer');
  assert.equal(writeBlockChecked(content, 'faq:0', { question: 'Q2', answer: 'A2' }).faqItems[0].answer, 'A2');
});

import { buildPreviewDocument as buildPreviewDocSafe } from './draft-live-preview.js';
test('raw HTML in a draft cannot put live code into the preview', () => {
  const shell = { shellHtml: '<html><head></head><body><h1>x</h1><div id="__draft_body__"></div></body></html>', regionHtml: '', classFor: () => '' };
  const content = { title: 'T', sections: [{ heading: 'H', body: 'Text <script>alert(1)</script> and <img src=x onerror="alert(2)"> and [a link](javascript:alert(3)) and <a href="javascript:alert(4)">x</a> end.' }] };
  const r = buildPreviewDocSafe(content, shell);
  assert.equal(r.ok, true);
  const body = r.html.replace(/<script>[\s\S]*?<\/script>\s*<\/body>/, '</body>'); // the preview's own selection script is the only script allowed
  assert.doesNotMatch(body, /alert\(/);
  assert.doesNotMatch(body, /onerror/i);
  assert.match(body, /Text/);
  assert.match(body, /end\./);
});
