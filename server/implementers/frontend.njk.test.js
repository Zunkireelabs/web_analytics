import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const pushed = [];
const realOps = await import(resolve('./lib/github-ops.js'));
mock.module(resolve('./lib/github-ops.js'), { namedExports: { ...realOps,
  resolveBatchBranch: async () => ({ batchInfo: { exists: false, branchName: 'batch/x', conflicted: false } }),
  baseBranch: () => 'main',
  pushDraftBranch: async (site, draft, files) => { pushed.push(files); return { ok: true, files }; },
} });
const FILES = { 'marketing/src/_data/blogOrder.json': '[\n "older-post",\n "oldest-post"\n]\n' };
const realClient = await import(resolve('../github/client.js'));
mock.module(resolve('../github/client.js'), { namedExports: { ...realClient, getFileContent: async (site, path) => (FILES[path] != null ? { content: FILES[path], sha: 'x' } : null) } });
// Minimal replacements, registered BEFORE frontend.js is first loaded (importing the real design-drift would load it early, through a cycle).
mock.module(resolve('./lib/design-gates.js'), { namedExports: { runDesignGates: async () => ({ ok: true }) } });
mock.module(resolve('../lib/design-protection/hooks.js'), { namedExports: { protectNewPage: async () => ({ ok: true }), toPendingError: async () => new Error('pending') } });
const { apply, preview, resolveTargetAndBody } = await import('./frontend.js');

const post = (slug, over = {}) => `---
layout: layouts/blog-article.njk
title: "Post ${slug} | Acme" # SEOAI:TITLE
h1: "Post ${slug}"
metaDescription: "About ${slug}." # SEOAI:METADESCRIPTION
datePublished: "${over.date || '2026-11-01'}"
dateModified: "${over.date || '2026-11-01'}"
ogType: article
bodyClass: page--light-nav page--pink-cta
category: "Salons"
categoryAnchor: "salons"
readTime: "5 min read"
subtitle: "Sub ${slug}."
coverImage: "/assets/images/c-${slug}.png"
coverAlt: "Cover ${slug}"
cardExcerpt: "Card ${slug}."
sidebarCtaHeading: "Side"
sidebarCtaBody: "Side body"
bottomCtaHeading: "Bottom"
bottomCtaBody: "Bottom body"
faq:
  - question: "Q ${slug}?"
    answer: "A ${slug}."
relatedReading:
  - url: "/features/booking/"
    label: "Booking"
keepReading:
  - link: "/blog/x/"
    image: "x.png"
    tag: "Salons"
    title: "X"
    read: "4 min read"
    tone: 1
---
<p>Body.</p>
`;
const treeFiles = ['marketing/src/blog/older-post.njk', 'marketing/src/blog/oldest-post.njk', 'marketing/src/blog/index.njk', 'marketing/src/_data/blogOrder.json'];
const repoDeps = () => ({
  getRepoTree: async () => ({ files: treeFiles }),
  getFileContent: async (site, p) => (p.endsWith('older-post.njk') ? { content: post('older-post', { date: '2026-11-18' }) } : p.endsWith('oldest-post.njk') ? { content: post('oldest-post') } : null),
  today: new Date('2026-11-26T08:00:00Z'),
});
const NJK_SITE = (extra = {}) => ({ id: 8872, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', website_domain: 'x.test', url_file_map: { newContentTargets: { 'blog-outline': { dir: 'marketing/src/blog', extension: '.njk', ...extra } } } });
const DRAFT = { action_type: 'blog-outline', finding_id: 'f', content: { title: 'Booking software for salons', quickAnswer: 'It saves time. It also cuts no-shows.', metaDescription: 'Booking software for salons.', faqItems: [{ question: 'Does it help?', answer: 'Yes.' }], sections: [{ heading: 'Time', body: 'Saves hours.\n\n- one\n- two' }], category: 'Salons' } };

describe('an .njk blog target is written in the site\'s own format', () => {
  test('resolveTargetAndBody: file under the target dir, front matter + HTML body, contentFormat html, with a note saying where the wording came from', async () => {
    const r = await resolveTargetAndBody(NJK_SITE(), DRAFT, repoDeps());
    assert.equal(r.ok, true); assert.equal(r.contentFormat, 'html'); assert.match(r.filePath, /^marketing\/src\/blog\/booking-software-for-salons\.njk$/);
    assert.match(r.body, /^---\nlayout: layouts\/blog-article\.njk\ntitle: "Booking software for salons \| Acme" # SEOAI:TITLE\n/);
    assert.match(r.body, /<h2>Time<\/h2>\n<p>Saves hours\.<\/p>\n<ul>\n<li>one<\/li>/); assert.doesNotMatch(r.body, /^## |\*\*/m);
    assert.match(r.notes[0], /taken from this site's own post "older-post"/);
  });
  test('a draft that cannot be written in the site\'s format is refused with what a person must supply (nothing guessed)', async () => {
    const r = await resolveTargetAndBody(NJK_SITE(), { ...DRAFT, content: { ...DRAFT.content, category: 'Unknown' } }, repoDeps());
    assert.equal(r.ok, false); assert.equal(r.reason, 'draft-not-ready');
  });
  test('the prepared-body fast path reports html for an .njk target and markdown for every other target (byte-for-byte as before)', async () => {
    const prepared = { action_type: 'blog-outline', rendered_body: '---\nlayout: x\n---\n<p>x</p>', target_file_path: 'marketing/src/blog/x.njk', content: {} };
    assert.equal((await resolveTargetAndBody(NJK_SITE(), prepared)).contentFormat, 'html');
    for (const cfg of [{ dir: 'src/blog', extension: '.md' }, { dir: 'src/blog', extension: '.njk', mode: 'clone-sibling' }, { dir: 'src/app', extension: '.tsx', filename: 'page.tsx' }, {}]) {
      const s = { id: 1, url_file_map: { newContentTargets: { 'blog-outline': cfg } } };
      assert.equal((await resolveTargetAndBody(s, { ...prepared, target_file_path: 'src/blog/x.md' })).contentFormat, 'markdown', JSON.stringify(cfg));
    }
    assert.equal((await resolveTargetAndBody(NJK_SITE(), { ...prepared, action_type: 'landing-page' })).contentFormat, 'markdown', 'only blog-outline changes');
  });
  test('a Markdown blog target still writes Markdown (unchanged branch)', async () => {
    const md = { id: 2, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } } };
    const r = await resolveTargetAndBody(md, { ...DRAFT, content: { ...DRAFT.content } }, { getRepoTree: async () => ({ files: ['src/blog/a.md'] }), getFileContent: async () => ({ content: '---\ntitle: "A"\nlayout: post.njk\n---\nbody' }) });
    assert.equal(r.ok, true); assert.equal(r.contentFormat, 'markdown'); assert.match(r.body, /^## Time/m);
  });
});

describe('apply — the post index file lands in the same commit', () => {
  const prepared = (extra) => ({ ...DRAFT, id: 7, rendered_body: '---\nlayout: layouts/blog-article.njk\n---\n<p>x</p>\n', target_file_path: 'marketing/src/blog/booking-software-for-salons.njk', ...extra });
  test('configured: the slug is added at the top of the index in the same push as the post', async () => {
    pushed.length = 0;
    const r = await apply(NJK_SITE({ orderFile: { path: 'marketing/src/_data/blogOrder.json' } }), prepared());
    assert.equal(r.ok, true); const files = pushed.at(-1);
    assert.deepEqual(files.map((f) => f.path), ['marketing/src/blog/booking-software-for-salons.njk', 'marketing/src/_data/blogOrder.json']);
    assert.deepEqual(JSON.parse(files[1].content), ['booking-software-for-salons', 'older-post', 'oldest-post']);
    assert.equal(files[0].contentFormat, 'html');
  });
  test('position bottom is honoured', async () => {
    pushed.length = 0; await apply(NJK_SITE({ orderFile: { path: 'marketing/src/_data/blogOrder.json', position: 'bottom' } }), prepared());
    assert.deepEqual(JSON.parse(pushed.at(-1)[1].content).at(-1), 'booking-software-for-salons');
  });
  test('not configured: only the post is pushed (no other client\'s behaviour changes)', async () => {
    pushed.length = 0; await apply(NJK_SITE(), prepared());
    assert.deepEqual(pushed.at(-1).map((f) => f.path), ['marketing/src/blog/booking-software-for-salons.njk']);
  });
  test('a configured index that cannot be read stops the whole apply: the post is never pushed without it', async () => {
    pushed.length = 0; const r = await apply(NJK_SITE({ orderFile: { path: 'marketing/src/_data/missing.json' } }), prepared());
    assert.equal(r.ok, false); assert.equal(r.reason, 'invalid-edit'); assert.equal(pushed.length, 0);
  });
  test('the index file is shown to the reviewer in the preview', async () => {
    const r = await preview(NJK_SITE({ orderFile: { path: 'marketing/src/_data/blogOrder.json' } }), prepared());
    assert.ok(r.changedRegions.some((c) => c.field === 'file: marketing/src/_data/blogOrder.json' && /booking-software-for-salons/.test(c.after)));
  });
  test('a Markdown draft never touches an index file', async () => {
    pushed.length = 0; await apply({ id: 3, url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md', orderFile: { path: 'x.json' } } } } }, { ...DRAFT, rendered_body: '---\nt: x\n---\nb', target_file_path: 'src/blog/x.md' });
    assert.deepEqual(pushed.at(-1).map((f) => f.path), ['src/blog/x.md']);
  });
});
