import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from './blog-pagination.js';
import { pagerClassesFromDesignProfile, recipeSupported, supportedFrameworks } from './lib/pagination/recipes.js';

const LISTING = `---
title: "Guides | Example Co"
description: "Practical guides."
layout: base.njk
---
{% for post in collections.blog %}<a href="{{ post.url }}">{{ post.data.title }}</a>{% endfor %}
`;
const baseSite = (over = {}) => ({
  id: 7, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main',
  url_file_map: { pages: { '/blog': { file: 'src/blog/index.njk' } }, siteRoot: { designProfile: { components: { button: { primary: 'btn primary', secondary: 'btn ghost' } } } } },
  ...over,
});
const eleventyTree = { files: ['package.json', '.eleventy.js', 'src/blog/index.njk', 'src/index.njk'] };
const eleventyPkg = JSON.stringify({ devDependencies: { '@11ty/eleventy': '^3.1.6' } });
const deps = (over = {}) => ({
  loadSite: async () => baseSite(),
  readFile: async (_s, path) => (path === 'src/blog/index.njk' ? { content: LISTING } : path === 'package.json' ? { content: eleventyPkg } : null),
  readTree: async () => eleventyTree,
  ...over,
});
const gen = (params = { listing: 'https://x.test/blog' }, over = {}) => generate({ siteId: 7, params }, deps(over));
const refusal = async (promise, reason) => { await assert.rejects(promise, (e) => { assert.equal(e.reason, reason, e.message); assert.equal(e.refusal, true); assert.equal(e.userFacing, true); assert.ok(e.message.length > 20); return true; }); };

describe('generate: the success path', () => {
  test('plans the change from the real file and carries before and after, so the implementer can verify the file is unchanged', async () => {
    const r = await gen();
    assert.equal(r.content.framework, 'eleventy');
    assert.equal(r.content.pageSize, 12);
    assert.equal(r.content.files.length, 1);
    assert.equal(r.content.files[0].path, 'src/blog/index.njk');
    assert.equal(r.content.files[0].before, LISTING);
    assert.match(r.content.files[0].after, /^pagination:/m);
    assert.match(r.summary, /Paginate https:\/\/x\.test\/blog \(eleventy, 12 posts per page\)/);
  });
  test('the pager uses the site\'s OWN buttons: secondary for links, primary for the current page', async () => {
    const r = await gen();
    assert.match(r.content.files[0].after, /<a class="btn ghost" href="\{\{ pagination\.hrefs/);
    assert.match(r.content.files[0].after, /<span class="btn primary" aria-current="page">/);
  });
  test('a site with no design profile still gets a draft, with the unstyled pager called out in its notes', async () => {
    const r = await gen(undefined, { loadSite: async () => baseSite({ url_file_map: { pages: { '/blog': { file: 'src/blog/index.njk' } } } }) });
    assert.match(r.content.notes.join('\n'), /unstyled/);
  });
  test('the page size can be chosen', async () => assert.match((await gen({ listing: 'https://x.test/blog', pageSize: 9 })).content.files[0].after, /size: 9/));
});

describe('generate: it refuses, with a reason, whatever it cannot do safely', () => {
  test('no listing given', async () => assert.rejects(gen({}), /listing is required/));
  test('no repository connected', () => refusal(gen(undefined, { loadSite: async () => baseSite({ repo_owner: null }) }), 'no-repo'));
  test('the listing URL is not mapped to a source file', () => refusal(gen({ listing: 'https://x.test/journal' }), 'no-file-mapping'));
  test('the mapped file does not exist', () => refusal(gen(undefined, { readFile: async () => null }), 'file-not-found'));
  test('a framework with no recipe yet (Hugo): named, with what IS supported', async () => {
    await assert.rejects(gen(undefined, { readTree: async () => ({ files: ['hugo.toml', 'content/blog/_index.md', 'src/blog/index.njk'] }), readFile: async (_s, p) => (p === 'src/blog/index.njk' ? { content: LISTING } : null) }), (e) => {
      assert.equal(e.reason, 'no-recipe');
      assert.match(e.message, /Hugo/);
      assert.match(e.message, /supported: eleventy, astro, nextjs/);
      return true;
    });
  });
  test('a repository whose framework cannot be identified', () => refusal(gen(undefined, { readTree: async () => ({ files: ['README.md'] }), readFile: async (_s, p) => (p === 'src/blog/index.njk' ? { content: LISTING } : null) }), 'framework-unclear'));
  test('a listing the recipe cannot handle is refused with the recipe\'s own reason (hand-written, JSON front matter)', () => refusal(gen(undefined, { readFile: async (_s, p) => (p === 'package.json' ? { content: eleventyPkg } : { content: '---\n{"title":"Blog"}\n---\n<p>cards</p>' }) }), 'json-front-matter'));
  test('an already paginated listing is refused, not rewritten', () => refusal(gen(undefined, { readFile: async (_s, p) => (p === 'package.json' ? { content: eleventyPkg } : { content: LISTING.replace('layout: base.njk', 'layout: base.njk\npagination:\n  data: collections.blog\n  size: 10\n  alias: posts') }) }), 'already-paginated'));
});

describe('generate: Astro', () => {
  const ASTRO = `---
import Layout from '../../layouts/Layout.astro';
import { getCollection } from 'astro:content';
const posts = (await getCollection('blog')).sort((a, b) => b.data.date - a.data.date);
---
<Layout title="Blog | Acme" description="Posts">
<div class="grid">{posts.map((p) => <a href={p.slug}>{p.data.title}</a>)}</div>
</Layout>
`;
  const astroDeps = (config = "export default { trailingSlash: 'always' };") => ({
    loadSite: async () => baseSite({ url_file_map: { pages: { '/blog': { file: 'src/pages/blog/index.astro' } }, siteRoot: { designProfile: { components: { button: { primary: 'btn primary', secondary: 'btn ghost' } } } } } }),
    readTree: async () => ({ files: ['package.json', 'astro.config.mjs', 'src/pages/blog/index.astro'] }),
    readFile: async (_s, p) => (p === 'package.json' ? { content: JSON.stringify({ dependencies: { astro: '^5.0.0' } }) } : p === 'astro.config.mjs' ? { content: config } : p === 'src/pages/blog/index.astro' ? { content: ASTRO } : null),
  });
  test('the draft carries the edited listing and the NEW page 2+ route (before: null); trailingSlash is read from the repo config', async () => {
    const r = await generate({ siteId: 7, params: { listing: 'https://x.test/blog' } }, astroDeps());
    assert.equal(r.content.framework, 'astro');
    assert.equal(r.content.files.length, 2);
    assert.equal(r.content.files[0].before, ASTRO);
    assert.deepEqual([r.content.files[1].path, r.content.files[1].before], ['src/pages/blog/page/[page].astro', null]);
    assert.match(r.content.files[0].after, /"\/blog\/" : "\/blog" \+ '\/page\/' \+ n \+ "\/"/);
    assert.match(r.content.files[0].after, /class="btn ghost"/);
  });
  test('without a trailingSlash setting the links carry none', async () => {
    const r = await generate({ siteId: 7, params: { listing: 'https://x.test/blog' } }, astroDeps('export default {};'));
    assert.match(r.content.files[0].after, /\? "\/blog" : "\/blog" \+ '\/page\/' \+ n \+ ""/);
  });
});

describe('generate: Next.js', () => {
  const NEXT_PAGE = `import type { Metadata } from "next";
import { getPosts } from "@/lib/posts";

export const metadata: Metadata = { title: "Blog | Acme", description: "Posts.", alternates: { canonical: "https://acme.test/blog" } };

export default async function BlogPage() {
  const posts = await getPosts();
  return (
    <main>
      <div className="grid">{posts.map((p) => <a key={p.slug} href={p.slug}>{p.title}</a>)}</div>
      <footer>x</footer>
    </main>
  );
}
`;
  const nextDeps = (pkg = { dependencies: { next: '^16.1.6', react: '19.2.3' } }, config = 'export default { trailingSlash: true };') => ({
    loadSite: async () => baseSite({ url_file_map: { pages: { '/blog': { file: 'src/app/blog/page.tsx' } }, siteRoot: {} } }),
    readTree: async () => ({ files: ['package.json', 'next.config.ts', 'src/app/blog/page.tsx', 'src/app/layout.tsx'] }),
    readFile: async (_s, p) => (p === 'package.json' ? { content: JSON.stringify(pkg) } : p === 'next.config.ts' ? { content: config } : p === 'src/app/blog/page.tsx' ? { content: NEXT_PAGE } : null),
  });
  test('the draft carries the rewritten page plus the two NEW files, with the Next version and trailingSlash read from the repo', async () => {
    const r = await generate({ siteId: 7, params: { listing: 'https://x.test/blog' } }, nextDeps());
    assert.equal(r.content.framework, 'nextjs');
    assert.deepEqual(r.content.files.map((f) => [f.path, f.before === null]), [
      ['src/app/blog/page.tsx', false], ['src/app/blog/PaginatedListing.tsx', true], ['src/app/blog/page/[page]/page.tsx', true],
    ]);
    assert.match(r.content.files[2].after, /params: Promise<\{ page: string \}>/);
    assert.match(r.content.files[1].after, /"\/blog\/" : "\/blog" \+ "\/page\/" \+ n \+ "\/"/);
  });
  test('Next 14 gets synchronous params', async () => {
    const r = await generate({ siteId: 7, params: { listing: 'https://x.test/blog' } }, nextDeps({ dependencies: { next: '14.2.3' } }, ''));
    assert.match(r.content.files[2].after, /params: \{ page: string \}/);
  });
  test('a listing this recipe cannot move is refused with the recipe\'s reason', () => refusal(
    generate({ siteId: 7, params: { listing: 'https://x.test/blog' } }, { ...nextDeps(), readFile: async (_s, p) => (p === 'src/app/blog/page.tsx' ? { content: `"use client";\n${NEXT_PAGE}` } : { content: '{"dependencies":{"next":"16.0.0"}}' }) }),
    'client-component',
  ));
});

describe('the recipe registry and design-profile helper', () => {
  test('only frameworks with a recipe are supported', () => {
    assert.equal(recipeSupported('eleventy'), true);
    assert.equal(recipeSupported('astro'), true);
    assert.equal(recipeSupported('nextjs'), true);
    for (const fw of ['hugo', 'gatsby', null, undefined, '__proto__', 'constructor']) assert.equal(recipeSupported(fw), false, String(fw));
    assert.deepEqual(supportedFrameworks(), ['eleventy', 'astro', 'nextjs']);
  });
  test('button classes come from the profile: secondary for links, primary for the current page; either alone is used for both', () => {
    assert.deepEqual(pagerClassesFromDesignProfile({ components: { button: { primary: ' a ', secondary: 'b' } } }), { buttonClass: 'b', currentClass: 'a' });
    assert.deepEqual(pagerClassesFromDesignProfile({ components: { button: { primary: 'a', secondary: null } } }), { buttonClass: 'a', currentClass: 'a' });
    assert.deepEqual(pagerClassesFromDesignProfile({ components: { button: { primary: null, secondary: 'b' } } }), { buttonClass: 'b', currentClass: 'b' });
    for (const bad of [null, {}, { components: {} }, { components: { button: { primary: '', secondary: ' ' } } }]) assert.deepEqual(pagerClassesFromDesignProfile(bad), { buttonClass: null, currentClass: null });
  });
});
