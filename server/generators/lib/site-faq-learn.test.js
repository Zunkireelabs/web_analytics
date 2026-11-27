import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickFaqSourcePages, learnSiteFaqTemplate, clearSiteFaqCache, sectionAroundFaq, pickFaqSourceFiles, learnRepoFaqTemplate, clearRepoFaqCache } from './site-faq-learn.js';

const PRICING = '<html><body><section class="faq-x"><div class="faq-x__in"><h2 class="faq-x__h">Frequently asked questions</h2><div class="faq-x__l"><details><summary>One?</summary><p>Answer one.</p></details><details><summary>Two?</summary><p>Answer two.</p></details></div></div></section></body></html>';

describe('the pages tried for a site\'s own FAQ design', () => {
  test('the home page first, then pages likely to carry a FAQ; never files, blog posts, or query strings', () => {
    const pages = ['https://s.example/blog/a/', 'https://s.example/logo.png', 'https://s.example/zzz', 'https://s.example/pricing', 'https://s.example/', 'https://s.example/about?x=1', 'https://s.example/contact', 'https://s.example/pricing/'];
    assert.deepEqual(pickFaqSourcePages(pages), ['https://s.example/', 'https://s.example/pricing', 'https://s.example/contact', 'https://s.example/zzz']);
  });
  test('at most eight pages', () => {
    const pages = Array.from({ length: 30 }, (_, i) => `https://s.example/p${i}`);
    assert.equal(pickFaqSourcePages(pages).length, 8);
  });
});

describe('learning a site\'s FAQ design from its other pages', () => {
  test('the first page whose FAQ block the learner can read gives the design', async () => {
    clearSiteFaqCache();
    const fetchHtml = async (url) => (url.endsWith('/pricing') ? PRICING : '<html><body><p>No FAQ here.</p></body></html>');
    const t = await learnSiteFaqTemplate({ id: 1 }, { listPages: async () => ['https://s.example/', 'https://s.example/pricing', 'https://s.example/about'], fetchHtml });
    assert.equal(t.wrapper, '<div class="faq-x__in"><h2 class="faq-x__h">Frequently asked questions</h2><div class="faq-x__l">{{ROWS}}</div></div>');
    assert.equal(t.row, '<details><summary>{{QUESTION}}</summary><p>{{ANSWER}}</p></details>');
    assert.equal(t.learnedFrom, 'https://s.example/pricing');
  });
  test('kept per site: a second call reads nothing', async () => {
    clearSiteFaqCache();
    let fetches = 0;
    const deps = { listPages: async () => ['https://s.example/pricing'], fetchHtml: async () => { fetches++; return PRICING; } };
    await learnSiteFaqTemplate({ id: 2 }, deps);
    await learnSiteFaqTemplate({ id: 2 }, deps);
    assert.equal(fetches, 1);
  });
  test('no FAQ on any page, an unreachable page, or no pages at all: null, never an error', async () => {
    clearSiteFaqCache();
    assert.equal(await learnSiteFaqTemplate({ id: 3 }, { listPages: async () => ['https://s.example/'], fetchHtml: async () => '<html></html>' }), null);
    assert.equal(await learnSiteFaqTemplate({ id: 4 }, { listPages: async () => ['https://s.example/'], fetchHtml: async () => { throw new Error('down'); } }), null);
    assert.equal(await learnSiteFaqTemplate({ id: 5 }, { listPages: async () => [], fetchHtml: async () => PRICING }), null);
    assert.equal(await learnSiteFaqTemplate(null), null);
  });
});

const SERVICES_NJK = `---
title: "Services"
---
<section class="faq-sec" id="faq">
  <div class="container">
    <span class="eyebrow">FAQ</span>
    <h2>Frequently asked questions</h2>
    <details><summary>What do you do?</summary><p>We help.</p></details>
    <details><summary>Where?</summary><p>Everywhere.</p></details>
  </div>
</section>
`;

describe('a site\'s FAQ design from its own repo files', () => {
  test('the band the FAQ sits in is found from the page source', () => {
    assert.equal(sectionAroundFaq(SERVICES_NJK), '<section class="faq-sec" id="faq">');
    assert.equal(sectionAroundFaq('<div class="x"><h2>Frequently asked questions</h2></div>'), null);
  });
  test('non-blog template files, likely ones first; never the blog folder, node_modules or images', () => {
    const files = ['src/blog/a/index.njk', 'src/misc.njk', 'src/services/index.njk', 'src/logo.png', 'node_modules/x/y.html', 'src/about-us/index.njk'];
    assert.deepEqual(pickFaqSourceFiles(files, { blogDir: 'src/blog' }), ['src/services/index.njk', 'src/about-us/index.njk', 'src/misc.njk']);
  });
  test('the first file whose FAQ can be read gives the design; with the band when asked', async () => {
    clearRepoFaqCache();
    const read = async (_s, path) => (path === 'src/services/index.njk' ? { content: SERVICES_NJK } : { content: '<p>nothing</p>' });
    const tree = async () => ({ files: ['src/about/index.njk', 'src/services/index.njk', 'src/blog/a/index.njk'] });
    const plain = await learnRepoFaqTemplate({ id: 11 }, { getRepoTree: tree, getFileContent: read, ref: 'main', blogDir: 'src/blog' });
    assert.match(plain.wrapper, /^<div class="container">/);
    assert.equal(plain.row, '<details><summary>{{QUESTION}}</summary><p>{{ANSWER}}</p></details>');
    const band = await learnRepoFaqTemplate({ id: 11 }, { getRepoTree: tree, getFileContent: read, ref: 'main', blogDir: 'src/blog', withSection: true });
    assert.match(band.wrapper, /^<section class="faq-sec" id="faq"><div class="container">/);
    assert.match(band.wrapper, /<\/section>$/);
    assert.equal(band.learnedFrom, 'main:src/services/index.njk');
  });
  test('no FAQ in any file, or the repo cannot be read: null, never an error', async () => {
    clearRepoFaqCache();
    assert.equal(await learnRepoFaqTemplate({ id: 12 }, { getRepoTree: async () => ({ files: ['src/a.njk'] }), getFileContent: async () => ({ content: '<p>x</p>' }), ref: 'main' }), null);
    assert.equal(await learnRepoFaqTemplate({ id: 13 }, { getRepoTree: async () => { throw new Error('403'); }, getFileContent: async () => null, ref: 'main' }), null);
  });
});

test('the repo FAQ answer is keyed by branch and blog folder, and "nothing found" after a failed read is not remembered', async () => {
  clearRepoFaqCache();
  const site = { id: 91 };
  const html = '<section><h2>Frequently asked questions</h2><details><summary>Q one</summary><p>A one</p></details><details><summary>Q two</summary><p>A two</p></details></section>';
  let flaky = true;
  const deps = (extra = {}) => ({ getRepoTree: async () => ({ files: ['src/services.njk'] }), getFileContent: async () => { if (flaky) throw new Error('rate limited'); return { content: html }; }, ...extra });
  assert.equal(await learnRepoFaqTemplate(site, { ...deps(), ref: 'main' }), null);
  flaky = false;
  const again = await learnRepoFaqTemplate(site, { ...deps(), ref: 'main' });
  assert.ok(again === null || again.items, 'a failed read was not cached as "no FAQ"');
  let asked = 0;
  await learnRepoFaqTemplate(site, { ...deps({ getFileContent: async () => { asked += 1; return { content: html }; } }), ref: 'stage' });
  assert.ok(asked > 0, 'stage is not answered from the main entry');
});
