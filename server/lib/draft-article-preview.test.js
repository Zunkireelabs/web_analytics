import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
const { articleHtmlFor, previewDraftInSiteArticle, optionArticleFor, previewBlogOptionInSiteArticle, clearOptionPreviewCacheForTests } = await import('./draft-article-preview.js');

const draft = { action_type: 'blog-outline', content: { title: 'Study in the UK', sections: [{ heading: 'Costs', body: 'Fees vary.\n\nLiving costs <b>too</b>.' }], suggestedFaqTopics: ['Do I need IELTS?'] } };
const site = { url_file_map: { siteRoot: { designProfile: { pages: [] } } } };

describe('articleHtmlFor', () => {
  test('sections become headings and paragraphs, in order, with the questions after', () => {
    const a = articleHtmlFor(draft);
    assert.equal(a.title, 'Study in the UK');
    assert.match(a.html, /<h2>Costs<\/h2><p>Fees vary\.<\/p>/);
    assert.match(a.html, /<h2>Questions readers ask<\/h2><h3>Do I need IELTS\?<\/h3>/);
  });
  test('only articles; a draft with no title is not drawn', () => {
    assert.equal(articleHtmlFor({ action_type: 'faq', content: {} }), null);
    assert.equal(articleHtmlFor({ action_type: 'blog-outline', content: {} }), null);
  });
  test('heading text is escaped', () => assert.match(articleHtmlFor({ action_type: 'blog-outline', content: { title: 't', sections: [{ heading: '<script>', body: 'x' }] } }).html, /&lt;script&gt;/));
});

describe('previewDraftInSiteArticle', () => {
  test('not an article: says so without drawing', async () => {
    const r = await previewDraftInSiteArticle(site, { action_type: 'faq', content: {} }, { render: async () => { throw new Error('must not draw'); } });
    assert.equal(r.reason, 'not-an-article');
  });
  test('no captured article on the site: says what is missing, never invents a template', async () => {
    const r = await previewDraftInSiteArticle(site, draft, { render: async () => { throw new Error('must not draw'); } });
    assert.equal(r.reason, 'no-reference-article');
  });
});

describe('with a captured article', () => {
  const withArticle = { url_file_map: { siteRoot: { designProfile: { pages: [{ url: 'https://admizz.com/blogs/a-post', pageType: 'blog-article' }, { url: 'https://admizz.com/', pageType: 'homepage' }] } } } };
  test('draws into that article and returns base64 pictures with the deviations', async () => {
    let seen;
    const r = await previewDraftInSiteArticle(withArticle, draft, { render: async (o) => { seen = o; return { ok: true, shots: [{ viewport: 'desktop', width: 1280, height: 3000, png: Buffer.from('PNG') }], deviations: [], matchesSiteDesign: true }; } });
    assert.equal(seen.referenceUrl, 'https://admizz.com/blogs/a-post');
    assert.equal(seen.title, 'Study in the UK');
    assert.equal(r.ok, true); assert.equal(r.shots[0].png, Buffer.from('PNG').toString('base64')); assert.equal(r.matchesSiteDesign, true);
  });
  test('a browser failure is reported, not hidden', async () => {
    const r = await previewDraftInSiteArticle(withArticle, draft, { render: async () => ({ ok: false, reason: 'unreachable', error: 'net down' }) });
    assert.deepEqual([r.ok, r.reason, r.error], [false, 'unreachable', 'net down']);
  });
  test('a reference with no body region is reported', async () => {
    const r = await previewDraftInSiteArticle(withArticle, draft, { render: async () => ({ ok: true, skip: true, reason: 'no-body-region-on-reference' }) });
    assert.equal(r.reason, 'no-body-region-on-reference');
  });
});

describe('blog option drawn in the real article page', () => {
  const withArticle = { id: 9, url_file_map: { siteRoot: { designProfile: { pages: [{ url: 'https://x.com/blog/a-post', pageType: 'blog-article' }] } } } };
  const ok = async () => ({ ok: true, shots: [{ viewport: 'desktop', width: 1280, height: 2000, png: Buffer.from('PNG') }], deviations: [], matchesSiteDesign: true });
  test('each option has its own structure, the title is kept and escaped, and a bad option or empty title is refused', () => {
    assert.match(optionArticleFor('A', 'Rising tech').html, /<h2>Why it matters<\/h2>/);
    assert.match(optionArticleFor('B', 'Rising tech').html, /Short answer/);
    assert.match(optionArticleFor('C', 'Rising tech').html, /<h3>What does it cost\?<\/h3>/);
    assert.equal(optionArticleFor('A', 'Rising tech').title, 'Rising tech');
    assert.equal(optionArticleFor('Z', 'x'), null);
    assert.equal(optionArticleFor('A', '   '), null);
  });
  test('draws in the site\'s own captured article with the idea title, and a repeat look does not open the browser again', async () => {
    clearOptionPreviewCacheForTests();
    let calls = 0; let seen;
    const render = async (o) => { calls += 1; seen = o; return ok(); };
    const a = await previewBlogOptionInSiteArticle(withArticle, 'B', 'Rising tech', { render });
    const b = await previewBlogOptionInSiteArticle(withArticle, 'B', 'Rising tech', { render });
    assert.equal(seen.referenceUrl, 'https://x.com/blog/a-post'); assert.equal(seen.title, 'Rising tech');
    assert.equal(a.ok, true); assert.equal(calls, 1); assert.equal(b.ok, true);
  });
  test('a site with no captured article is told so, never given an invented template; a failed drawing is not cached', async () => {
    clearOptionPreviewCacheForTests();
    const r = await previewBlogOptionInSiteArticle({ id: 5, url_file_map: { siteRoot: { designProfile: { pages: [] } } } }, 'A', 't', { render: async () => { throw new Error('must not draw'); } });
    assert.equal(r.reason, 'no-reference-article');
    let n = 0;
    const bad = async () => { n += 1; return { ok: false, reason: 'unreachable', error: 'x' }; };
    await previewBlogOptionInSiteArticle(withArticle, 'A', 't', { render: bad }); await previewBlogOptionInSiteArticle(withArticle, 'A', 't', { render: bad });
    assert.equal(n, 2);
  });
});

describe('landing page and translation options in the site\'s own captured page', () => {
  const site = { id: 3, url_file_map: { siteRoot: { designProfile: { pages: [{ url: 'https://x.com/', pageType: 'homepage' }, { url: 'https://x.com/lp/offer', pageType: 'landing' }, { url: 'https://x.com/services/web', pageType: 'service' }] } } } };
  const ok = async () => ({ ok: true, shots: [{ viewport: 'desktop', width: 1280, height: 2000, png: Buffer.from('P') }], deviations: [], matchesSiteDesign: true });
  test('a landing option is drawn in the site\'s captured landing page; a translation in the page being translated', async () => {
    const { previewOptionInSiteTemplate } = await import('./draft-article-preview.js');
    clearOptionPreviewCacheForTests();
    let seen;
    await previewOptionInSiteTemplate(site, { generatorId: 'landing-page', optionKey: 'A', title: 'Our offer' }, { render: async (o) => { seen = o; return ok(); } });
    assert.equal(seen.referenceUrl, 'https://x.com/lp/offer');
    await previewOptionInSiteTemplate(site, { generatorId: 'translation', optionKey: 'B', title: 'Web design', pageUrl: 'https://x.com/services/web' }, { render: async (o) => { seen = o; return ok(); } });
    assert.equal(seen.referenceUrl, 'https://x.com/services/web');
    assert.match(seen.bodyHtml, /inteligencia artificial/);
  });
  test('an unknown kind is refused', async () => {
    const { optionPageFor } = await import('./draft-article-preview.js');
    assert.equal(optionPageFor('meta-title', 'A', 't'), null);
  });
});
