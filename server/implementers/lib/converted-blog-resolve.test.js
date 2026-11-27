import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConvertedBlogPost, originFor, fillFaqMarkers } from './converted-blog-resolve.js';
import { fmValue } from './converted-blog-page.js';

const ORIGIN = 'https://client.example';
const REF = `---
{
  "layout": "layouts/base.njk",
  "permalink": "/blog/old-ref/index.html",
  "headInclude": "heads/blog-old-ref-index.njk",
  "title": "Old Reference Guide | ACME", # SEOAI:TITLE
  "documentStart": "<!DOCTYPE html>\\n<html lang=\\"en\\">\\n",
  "description": "A reference description that must never leak into another post.", # SEOAI:METADESCRIPTION
  "componentBase": "../../"
}
---
<main class="blog-page"><article class="blog-article"><header class="blog-header"><h1>The reference headline</h1>
<p>The reference lead sentence about one thing.</p><p class="article-meta"><time datetime="2024-05-22">May 22, 2024</time></p></header>
<img class="blog-image" src="../../images/blog/b3.jpg" alt="x"><div class="blog-content"><p>Reference body.</p></div></article></main>
`;
const HEAD = `<title>{{ title }}</title><link rel="canonical" href="${ORIGIN}/blog/old-ref/"><meta property="og:url" content="${ORIGIN}/blog/old-ref/"><meta property="og:image" content="${ORIGIN}/images/blog/b3.jpg">`;
const LISTING = `---\n{ "componentBase": "../../" }\n---\n<section><a href="../old-ref/" class="blog-card"><img src="../../images/blog/b3.jpg" alt="x"><div><span class="blog-date">22 May 2024</span><h2>Old</h2><p>Old summary.</p></div></a></section>`;
const FILES = { 'src/blog/old-ref/index.njk': REF, 'src/_includes/heads/blog-old-ref-index.njk': HEAD, 'src/blog/all/index.njk': LISTING };
const readFile = async (_s, p) => (p in FILES ? { content: FILES[p] } : null);
const site = { id: 8874, name: 'MOBILISE', website_domain: 'client.example' };
const cfg = { mode: 'clone-sibling', dir: 'src/blog', filename: 'index.njk', referencePage: 'src/blog/old-ref/index.njk', headDir: 'src/_includes', listingPage: 'src/blog/all/index.njk' };
const content = { title: 'Why Teams Stall', metaDescription: 'Why teams stall and what to do.', quickAnswer: 'A short lead.', sections: [{ heading: 'One', body: 'Text.' }], featuredImage: { url: '/images/blog/n.webp', alt: 'A team' }, publishedAt: '2026-11-24' };
const run = (over = {}, c = cfg, fp = 'src/blog/why-teams-stall/index.njk', rf = readFile) => resolveConvertedBlogPost(site, { ...content, ...over }, c, { filePath: fp, readFile: rf, today: '2026-11-25' });

describe('resolveConvertedBlogPost', () => {
  test('returns the page, its own head file and the listing card, as one set of files', async () => {
    const r = await run(); assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/blog/why-teams-stall/index.njk'); assert.equal(r.contentFormat, 'html-page', 'not "markdown": the page is written-out HTML in an .njk file');
    assert.equal(fmValue(/^---\n([\s\S]*?)\n---/.exec(r.body)[1], 'permalink'), '/blog/why-teams-stall/index.html');
    assert.deepEqual(r.extraFiles.map((f) => f.path), ['src/_includes/heads/blog-why-teams-stall-index.njk', 'src/blog/all/index.njk']);
    assert.match(r.extraFiles[0].content, /client\.example\/blog\/why-teams-stall\//); assert.doesNotMatch(r.extraFiles[0].content, /old-ref|b3\.jpg/);
    assert.match(r.extraFiles[1].content, /<a href="\.\.\/why-teams-stall\/" class="blog-card"><img src="\.\.\/\.\.\/images\/blog\/n\.webp"[\s\S]*Why Teams Stall/);
    assert.match(r.extraFiles[1].content, /href="\.\.\/old-ref\/"/, 'the existing card is still there');
    assert.equal(r.notes, undefined);
  });
  test('without a listing page configured, only the page and its head file', async () => {
    const r = await run({}, { ...cfg, listingPage: undefined }); assert.deepEqual(r.extraFiles.map((f) => f.path), ['src/_includes/heads/blog-why-teams-stall-index.njk']);
  });
  test('a listing that cannot take the card does not stop the post: it ships without it and says so', async () => {
    const files = { ...FILES, 'src/blog/all/index.njk': '<div>no cards</div>' };
    const r = await run({}, cfg, 'src/blog/why-teams-stall/index.njk', async (_s, p) => (p in files ? { content: files[p] } : null));
    assert.equal(r.ok, true); assert.equal(r.extraFiles.length, 1); assert.match(r.notes[0], /not added to src\/blog\/all\/index\.njk .*no-card-found.*by hand/);
    const gone = await run({}, cfg, 'src/blog/why-teams-stall/index.njk', async (_s, p) => (p === 'src/blog/all/index.njk' ? null : readFile(_s, p)));
    assert.match(gone.notes[0], /not found, so the new post is not listed/);
  });
  test('refuses when the address already exists, the reference or its head is missing, or nothing is configured', async () => {
    const taken = await run({}, cfg, 'src/blog/old-ref/index.njk'); assert.equal(taken.reason, 'slug-conflict');
    assert.equal((await run({}, { ...cfg, referencePage: 'src/blog/nope/index.njk' })).reason, 'no-file-mapping');
    assert.equal((await run({}, { ...cfg, referencePage: undefined })).reason, 'no-file-mapping');
    const noHead = { ...FILES }; delete noHead['src/_includes/heads/blog-old-ref-index.njk'];
    assert.equal((await run({}, cfg, 'src/blog/why-teams-stall/index.njk', async (_s, p) => (p in noHead ? { content: noHead[p] } : null))).reason, 'no-file-mapping');
    assert.equal(await resolveConvertedBlogPost({ id: 1 }, content, cfg, { filePath: 'src/blog/x/index.njk', readFile }).then((r) => r.reason), 'no-file-mapping');
  });
  test('a draft with no sections is "not ready"; a reference of the wrong shape is "invalid-edit"; nothing is returned to write', async () => {
    const empty = await run({ sections: [] }); assert.equal(empty.reason, 'draft-not-ready'); assert.equal(empty.extraFiles, undefined);
    const bad = await run({}, cfg, 'src/blog/why-teams-stall/index.njk', async (_s, p) => (p === cfg.referencePage ? { content: REF.replace('blog-content', 'other') } : readFile(_s, p)));
    assert.equal(bad.reason, 'invalid-edit'); assert.match(bad.error, /New post not written/);
  });
  test('originFor', () => { assert.equal(originFor({ website_domain: 'a.com/' }), 'https://a.com'); assert.equal(originFor({ website_domain: 'https://a.com' }), 'https://a.com'); assert.equal(originFor({}), null); });
});

// The post's FAQ is published in the site's own FAQ design, into the empty FAQ markers the site's posts carry.
describe('a converted post publishes its FAQ', () => {
  const TEMPLATE = { wrapper: '<section class="faq-sec" id="faq"><div class="container"><span class="eyebrow">FAQ</span><h2>Frequently asked questions</h2>{{ROWS}}</div></section>', row: '<details><summary>{{QUESTION}}</summary><p>{{ANSWER}}</p></details>' };
  const withFaq = { faqItems: [{ question: 'Is it free?', answer: 'Yes, & it costs $5 later.' }, { question: 'Who?', answer: 'Anyone.' }] };
  // The site's real posts carry the empty FAQ placeholders just before </main>.
  const readWithMarkers = async (_s, p) => (p === 'src/blog/old-ref/index.njk' ? { content: REF.replace('</main>', '<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->\n</main>') } : readFile(_s, p));
  const runWith = (learnFaq, over = withFaq) => resolveConvertedBlogPost(site, { ...content, ...over }, cfg, { filePath: 'src/blog/why-teams-stall/index.njk', readFile: readWithMarkers, today: '2026-11-25', learnFaq });

  test('the FAQ goes in the site\'s FAQ band, between the markers, escaped, and the rest of the page is as before', async () => {
    const r = await runWith(async () => TEMPLATE);
    assert.equal(r.ok, true);
    assert.match(r.body, /<!-- SEOAI:FAQ:START --><section class="faq-sec" id="faq"><div class="container"><span class="eyebrow">FAQ<\/span><h2>Frequently asked questions<\/h2><details><summary>Is it free\?<\/summary><p>Yes, &amp; it costs \$5 later\.<\/p><\/details><details><summary>Who\?<\/summary>/);
    assert.match(r.body, /<\/section><!-- SEOAI:FAQ:END -->/);
    assert.equal(r.notes, undefined);
  });
  test('a reference post with no FAQ placeholder: the post is written without a FAQ and says why', async () => {
    const r = await resolveConvertedBlogPost(site, { ...content, ...withFaq }, cfg, { filePath: 'src/blog/why-teams-stall/index.njk', readFile, today: '2026-11-25', learnFaq: async () => TEMPLATE });
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.body, /<details>/);
    assert.match(r.notes.join(' '), /no FAQ placeholder/);
  });
  test('no FAQ design anywhere on the site: nothing is added, and it says why', async () => {
    const r = await runWith(async () => null);
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.body, /<details>/);
    assert.match(r.notes.join(' '), /no FAQ design was found/);
  });
  test('a post with no FAQ items is written exactly as before', async () => {
    const r = await runWith(async () => { throw new Error('must not be asked'); }, {});
    assert.equal(r.ok, true);
    assert.equal(r.notes, undefined);
  });
  test('fillFaqMarkers: needs the markers, items and a design', () => {
    assert.equal(fillFaqMarkers('<p>no markers</p>', [{ question: 'q', answer: 'a' }], TEMPLATE).filled, false);
    assert.equal(fillFaqMarkers('<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->', [], TEMPLATE).filled, false);
    assert.equal(fillFaqMarkers('<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->', [{ question: 'q', answer: 'a' }], null).filled, false);
  });
});
