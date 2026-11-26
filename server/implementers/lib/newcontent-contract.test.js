import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveNewContentContract, deriveContractFromSourceFile, frontMatterKeys, makeContractCache, missingRequiredKeys, betterBlogDirectory } from './newcontent-contract.js';

// Shaped like a real site row: the branch column is `repo_default_branch`.
// There is no `default_branch` column, and the module used to read that name —
// see the refFor() comment in newcontent-contract.js.
const SITE = { id: 1, repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web', repo_default_branch: 'main' };

// Modelled on zunkireelabs-web/src/blog exactly as it really is: a directory
// data file supplies the layout, so no post declares one, and the hero image
// is called `featuredImage`.
const REAL_BLOG_DIR = {
  'src/blog/how-to-build-rag-pipeline.md': [
    '---',
    'title: "How to Build a RAG Pipeline"',
    'description: "Learn how to build a production-ready RAG pipeline."',
    'date: 2026-03-30',
    'authorId: sadin-shrestha',
    'category: Engineering',
    'tags:',
    '  - RAG',
    'featuredImage: /assets/images/blog/rag-pipeline-architecture.jpg',
    'featuredImageAlt: RAG pipeline architecture diagram',
    'readTime: 12',
    '---',
    '',
    '## What is a RAG Pipeline?',
  ].join('\n'),
  'src/blog/how-to-choose-ai-development-company.md': [
    '---',
    'title: "How to Choose an AI Development Company"',
    'date: 2026-04-02',
    'authorId: sadin-shrestha',
    'category: Guides',
    'featuredImage: /assets/images/blog/choose.jpg',
    'featuredImageAlt: Choosing a partner',
    'readTime: 9',
    '---',
    '',
    '## Start here',
  ].join('\n'),
  // Not representative: a directory data file and an index page.
  'src/blog/blog.json': '{ "layout": "blog-post.njk" }',
  'src/blog/index.njk': '---\nlayout: base.njk\n---\n',
};

function depsFor(files, { treeError = null, readError = null, counts = null, cache = null } = {}) {
  return {
    // `cache: null` by default so one test's fixture repo can never answer
    // another test's question through the module-level shared cache. Tests
    // that are ABOUT the cache pass their own.
    cache,
    getRepoTree: async (_site, ref) => {
      if (counts) { counts.tree = (counts.tree || 0) + 1; counts.refs = [...(counts.refs || []), ref]; }
      if (treeError) throw new Error(treeError);
      return { files: Object.keys(files), truncated: false };
    },
    // Mirrors the REAL getFileContent contract deliberately: { content, sha },
    // or null when the file isn't on this ref. Returning a bare string here is
    // what let the module ship calling .match() on the envelope object — the
    // mock was the only thing that made it look like it worked.
    getFileContent: async (_site, path, ref) => {
      if (counts) { counts.reads = (counts.reads || 0) + 1; counts.readRefs = [...(counts.readRefs || []), ref]; }
      if (readError) throw new Error(readError);
      return files[path] === undefined ? null : { content: files[path], sha: 'sha-fake' };
    },
  };
}

describe('frontMatterKeys', () => {
  test('reads top-level keys only', () => {
    const keys = frontMatterKeys('---\ntitle: "x"\ntags:\n  - a\n  - b\ndate: 2026-01-01\n---\nbody');
    assert.deepEqual(keys, ['title', 'tags', 'date']);
  });

  test('a file with no front matter has no keys', () => {
    assert.deepEqual(frontMatterKeys('# Just a heading'), []);
    assert.deepEqual(frontMatterKeys(''), []);
  });
});

describe('deriveNewContentContract — the real zunkireelabs-web blog directory', () => {
  test('emits NO layout, because the directory supplies its own', async () => {
    // This is the whole bug: every generated post declared `layout: base.njk`,
    // overriding blog.json's `blog-post.njk` and dropping the post out of the
    // blog template entirely.
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/blog', extension: '.md' }, depsFor(REAL_BLOG_DIR),
    );
    assert.equal(contract.unknown, false);
    assert.equal(contract.layout, null);
  });

  test('learns that this directory calls the hero image featuredImage', async () => {
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/blog', extension: '.md' }, depsFor(REAL_BLOG_DIR),
    );
    assert.equal(contract.fieldNames.featuredImage, 'featuredImage');
    assert.equal(contract.fieldNames.featuredImageAlt, 'featuredImageAlt');
  });

  test('ignores the directory data file and the index page', async () => {
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/blog', extension: '.md' }, depsFor(REAL_BLOG_DIR),
    );
    // index.njk declares `layout: base.njk`; counting it would have flipped
    // the answer back to the broken one.
    assert.equal(contract.sampled, 2);
  });
});

describe('deriveNewContentContract — a directory whose posts DO declare a layout', () => {
  const files = {
    'src/pages/about.njk': '---\nlayout: base.njk\ntitle: "About"\nimage: /a.jpg\n---\n',
    'src/pages/pricing.njk': '---\nlayout: base.njk\ntitle: "Pricing"\nimage: /b.jpg\n---\n',
  };

  test('emits the layout those siblings declare', async () => {
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/pages', extension: '.njk' }, depsFor(files),
    );
    assert.equal(contract.layout, 'base.njk');
  });

  test('learns this directory calls its image `image`, not featuredImage', async () => {
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/pages', extension: '.njk' }, depsFor(files),
    );
    assert.equal(contract.fieldNames.featuredImage, 'image');
  });

  test('one stray sibling with a layout does not flip a no-layout directory', async () => {
    const mixed = {
      ...REAL_BLOG_DIR,
      'src/blog/legacy-post.md': '---\nlayout: old-post.njk\ntitle: "Legacy"\n---\n',
    };
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/blog', extension: '.md' }, depsFor(mixed),
    );
    assert.equal(contract.layout, null, 'majority of real posts declare none');
  });
});

describe('deriveNewContentContract — nothing readable means nothing claimed', () => {
  test('an empty directory reports unknown so the caller keeps its config default', async () => {
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/newthing', extension: '.md' }, depsFor(REAL_BLOG_DIR),
    );
    assert.equal(contract.unknown, true);
    assert.equal(contract.layout, null);
  });

  test('a failed repo read reports unknown rather than a wrong answer', async () => {
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/blog', extension: '.md' }, depsFor(REAL_BLOG_DIR, { treeError: 'HTTP 403' }),
    );
    assert.equal(contract.unknown, true);
  });

  test('missing config is not an error, just unknown', async () => {
    assert.equal((await deriveNewContentContract(SITE, {}, depsFor({}))).unknown, true);
    assert.equal((await deriveNewContentContract(null, { dir: 'x', extension: '.md' }, depsFor({}))).unknown, true);
  });

  test('siblings in nested subdirectories are not treated as this directory', async () => {
    const nested = {
      'src/blog/2024/old.md': '---\nlayout: archive.njk\ntitle: "Old"\n---\n',
      ...REAL_BLOG_DIR,
    };
    const contract = await deriveNewContentContract(
      SITE, { dir: 'src/blog', extension: '.md' }, depsFor(nested),
    );
    assert.equal(contract.layout, null);
    assert.equal(contract.sampled, 2);
  });
});

describe('deriveNewContentContract — the branch it actually reads', () => {
  test('reads the site\'s repo_default_branch, not an undefined `default_branch`', async () => {
    // The whole module was inert in production because it read a column that
    // does not exist: the branch came out `undefined`, GitHub was asked for
    // /git/ref/heads/undefined, that 404'd, and the catch reported "unknown"
    // so every caller quietly kept the config-derived layout.
    const counts = {};
    await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, depsFor(REAL_BLOG_DIR, { counts }));
    assert.deepEqual(counts.refs, ['main']);
    assert.ok(counts.readRefs.length > 0);
    for (const ref of counts.readRefs) assert.equal(ref, 'main');
  });

  test('a site with no repo_default_branch falls back to main, never undefined', async () => {
    const counts = {};
    await deriveNewContentContract(
      { id: 2, repo_owner: 'o', repo_name: 'r' },
      { dir: 'src/blog', extension: '.md' },
      depsFor(REAL_BLOG_DIR, { counts }),
    );
    assert.deepEqual(counts.refs, ['main']);
  });
});

describe('deriveContractFromSourceFile — what a translation must look like', () => {
  // A real src/pages: not every page is built on the same layout, which is why
  // a translation reads its own source page instead of voting over the folder.
  const PAGES = {
    'src/pages/about.njk': '---\nlayout: page.njk\npermalink: /about/\ntitle: "About"\n---\n',
    'src/pages/home.njk': '---\nlayout: home.njk\ntitle: "Home"\n---\n',
    'src/pages/careers.njk': '---\nlayout: home.njk\ntitle: "Careers"\n---\n',
  };

  test('takes the layout from the exact page being translated', async () => {
    const contract = await deriveContractFromSourceFile(SITE, 'src/pages/about.njk', {}, depsFor(PAGES));
    assert.equal(contract.unknown, false);
    assert.equal(contract.layout, 'page.njk');
    assert.equal(contract.sampled, 1);
  });

  test('does not inherit the majority layout of the source page\'s neighbours', async () => {
    // home.njk is what most files in src/pages declare; about.es.njk must not
    // get it just because about.njk is outnumbered.
    const contract = await deriveContractFromSourceFile(SITE, 'src/pages/about.njk', {}, depsFor(PAGES));
    assert.notEqual(contract.layout, 'home.njk');
  });

  test('a source page that declares no layout means the translation declares none either', async () => {
    const files = { 'src/blog/post.md': '---\ntitle: "Post"\nfeaturedImage: /a.jpg\n---\n' };
    const contract = await deriveContractFromSourceFile(SITE, 'src/blog/post.md', {}, depsFor(files));
    assert.equal(contract.unknown, false);
    assert.equal(contract.layout, null);
    assert.equal(contract.fieldNames.featuredImage, 'featuredImage');
  });

  test('an unreadable source page is unknown, so the caller keeps its config default', async () => {
    assert.equal((await deriveContractFromSourceFile(SITE, 'src/pages/gone.njk', {}, depsFor(PAGES))).unknown, true);
    assert.equal((await deriveContractFromSourceFile(SITE, 'x.njk', {}, depsFor(PAGES, { readError: 'HTTP 403' }))).unknown, true);
    assert.equal((await deriveContractFromSourceFile(SITE, null, {}, depsFor(PAGES))).unknown, true);
  });

  test('never fetches a repo tree — it already knows the one path that matters', async () => {
    const counts = {};
    await deriveContractFromSourceFile(SITE, 'src/pages/about.njk', {}, depsFor(PAGES, { counts }));
    assert.equal(counts.tree, undefined);
    assert.equal(counts.reads, 1);
  });
});

describe('contract caching — one repo tree per batch run, not one per draft', () => {
  test('60 drafts against the same directory cost one tree fetch, not 60', async () => {
    const counts = {};
    const deps = depsFor(REAL_BLOG_DIR, { counts, cache: makeContractCache() });
    for (let i = 0; i < 60; i++) {
      const contract = await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, deps);
      assert.equal(contract.layout, null, 'every draft gets the same real answer');
    }
    assert.equal(counts.tree, 1);
    assert.equal(counts.reads, 2, 'only the two representative siblings, once');
  });

  test('a different site never gets another site\'s answer', async () => {
    // The cross-tenant case: same id space, different repo. A cache keyed
    // loosely enough to collide here would hand one client another client's
    // layout, in a PR against their real repo.
    const cache = makeContractCache();
    const other = { id: 1, repo_owner: 'someone-else', repo_name: 'other-site', repo_default_branch: 'main' };
    const mine = await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, depsFor(REAL_BLOG_DIR, { cache }));
    const theirs = await deriveNewContentContract(other, { dir: 'src/blog', extension: '.md' }, depsFor({
      'src/blog/post.md': '---\nlayout: article.njk\ntitle: "Post"\n---\n',
    }, { cache }));
    assert.equal(mine.layout, null);
    assert.equal(theirs.layout, 'article.njk');
  });

  test('directory, extension, branch and source file are all part of the key', async () => {
    const cache = makeContractCache();
    const files = {
      'src/blog/post.md': '---\ntitle: "Post"\n---\n',
      'src/pages/about.njk': '---\nlayout: page.njk\ntitle: "About"\n---\n',
    };
    const deps = depsFor(files, { cache });
    assert.equal((await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, deps)).layout, null);
    assert.equal((await deriveNewContentContract(SITE, { dir: 'src/pages', extension: '.njk' }, deps)).layout, 'page.njk');
    assert.equal((await deriveNewContentContract({ ...SITE, repo_default_branch: 'stage' }, { dir: 'src/pages', extension: '.njk' }, deps)).layout, 'page.njk');
    // The single-file path shares the cache object but not the key space.
    assert.equal((await deriveContractFromSourceFile(SITE, 'src/pages/about.njk', {}, deps)).sampled, 1);
  });

  test('a transient repo failure is not cached — the next draft gets a real answer', async () => {
    // Pinning a 403 for the whole TTL would silently downgrade every remaining
    // draft in the run to the config-derived layout, which is the original bug.
    const cache = makeContractCache();
    const failed = await deriveNewContentContract(
      SITE, { dir: 'src/blog', extension: '.md' }, depsFor(REAL_BLOG_DIR, { cache, treeError: 'HTTP 403' }),
    );
    assert.equal(failed.unknown, true);
    const retried = await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, depsFor(REAL_BLOG_DIR, { cache }));
    assert.equal(retried.unknown, false);
    assert.equal(retried.sampled, 2);
  });

  test('an entry expires, so a later run can never be served the previous run\'s repo', async () => {
    const cache = makeContractCache({ ttlMs: 1000 });
    const counts = {};
    const at = (now) => ({ ...depsFor(REAL_BLOG_DIR, { counts, cache }), now });
    await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, at(0));
    await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, at(999));
    assert.equal(counts.tree, 1, 'still inside the same run');
    await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, at(1000));
    assert.equal(counts.tree, 2, 'expired — re-derived against the repo as it is now');
  });

  test('the cache is bounded and evicts oldest-first', async () => {
    const cache = makeContractCache({ max: 2 });
    const files = {
      'a/x.md': '---\ntitle: "A"\n---\n', 'b/x.md': '---\ntitle: "B"\n---\n', 'c/x.md': '---\ntitle: "C"\n---\n',
    };
    const deps = depsFor(files, { cache });
    for (const dir of ['a', 'b', 'c']) await deriveNewContentContract(SITE, { dir, extension: '.md' }, deps);
    assert.equal(cache.size(), 2);
  });
});

// superrank-web (2026-11-23): an Astro content collection rejected a generated post ("excerpt: Required", no author/category/cover) and stopped the
// client's build. The generator now learns the summary key from the siblings, and knows which keys every sibling carries on a schema-validated site.
const post = (extra) => ['---', 'title: "T"', 'excerpt: "E"', 'date: 2026-01-01', 'author: team', 'category: News', ...extra, '---', '', 'Body'].join('\n');
const ASTRO_DIR = {
  'src/content.config.ts': 'export const collections = {};',
  'src/content/blog/a.md': post(['cover:', '  kind: agent']),
  'src/content/blog/b.md': post(['cover:', '  kind: agent']),
  'src/content/blog/c.md': post(['cover:', '  kind: pills']),
};
import { minimalCoverKindFromSchema } from './newcontent-contract.js';
describe('minimalCoverKindFromSchema', () => {
  test('finds a cover variant that is only `{ kind }` in the site\'s content schema', () => {
    const src = "const cover = z.discriminatedUnion('kind', [ z.object({ kind: z.literal('agent') }), z.object({ kind: z.literal('dark'), heading: z.string() }) ]);";
    assert.equal(minimalCoverKindFromSchema(src), 'agent');
  });
  test('a variant with any other field is not minimal, and no schema means no answer', () => {
    assert.equal(minimalCoverKindFromSchema("z.object({ kind: z.literal('dark'), heading: z.string() })"), null);
    assert.equal(minimalCoverKindFromSchema(''), null);
    assert.equal(minimalCoverKindFromSchema(undefined), null);
  });
});

describe('deriveNewContentContract — a schema-validated (Astro content collection) site', () => {
  const dir = { dir: 'src/content/blog', extension: '.md' };
  test('learns the summary key is `excerpt`, not `description`', async () => {
    const c = await deriveNewContentContract(SITE, dir, depsFor(ASTRO_DIR));
    assert.equal(c.fieldNames.description, 'excerpt');
  });
  test('requires every key all siblings carry (and never the optional-by-nature ones)', async () => {
    const files = { ...ASTRO_DIR, 'src/content/blog/d.md': post(['cover:', '  kind: agent', 'updated: 2026-02-01', 'featured: true']) };
    const c = await deriveNewContentContract(SITE, dir, depsFor(files));
    assert.equal(c.schemaValidated, true);
    assert.deepEqual(c.requiredKeys, ['author', 'category', 'cover', 'date', 'excerpt', 'title']);
  });
  test('a required key with the SAME value in every sibling is reused (author, category); titles and summaries are not, and a minimal `kind`-only cover a real post already uses is', async () => {
    const c = await deriveNewContentContract(SITE, dir, depsFor(ASTRO_DIR));
    assert.deepEqual(c.siblingConstants, { author: 'team', category: 'News', cover: { kind: 'agent' } });
  });
  test('an author or category that differs between posts takes the value most posts use, when at least two do (the client\'s own team, never invented)', async () => {
    const files = { ...ASTRO_DIR, 'src/content/blog/c.md': ASTRO_DIR['src/content/blog/c.md'].replace('author: team', 'author: Jo') };
    const c = await deriveNewContentContract(SITE, dir, depsFor(files));
    assert.equal(c.siblingConstants.author, 'team');
    assert.equal(c.siblingConstants.category, 'News');
  });
  test('when no value is shared by two posts, nothing is chosen', async () => {
    const files = {
      ...ASTRO_DIR,
      'src/content/blog/a.md': ASTRO_DIR['src/content/blog/a.md'].replace('author: team', 'author: Ann').replace('category: News', 'category: One'),
      'src/content/blog/b.md': ASTRO_DIR['src/content/blog/b.md'].replace('author: team', 'author: Bob').replace('category: News', 'category: Two'),
      'src/content/blog/c.md': ASTRO_DIR['src/content/blog/c.md'].replace('author: team', 'author: Cy').replace('category: News', 'category: Three'),
    };
    const c = await deriveNewContentContract(SITE, dir, depsFor(files));
    assert.equal(c.siblingConstants.author, undefined);
    assert.equal(c.siblingConstants.category, undefined);
  });
  test('a rich cover (more than `kind`) is never copied', async () => {
    const rich = (k) => post(['cover:', `  kind: ${k}`, '  heading: "H"', '  words: ["a"]']);
    const files = { 'src/content.config.ts': 'x', 'src/content/blog/a.md': rich('pills'), 'src/content/blog/b.md': rich('pills'), 'src/content/blog/c.md': rich('pills') };
    assert.equal((await deriveNewContentContract(SITE, dir, depsFor(files))).siblingConstants.cover, undefined);
  });
  test('missingRequiredKeys names what a generated file lacks', async () => {
    const c = await deriveNewContentContract(SITE, dir, depsFor(ASTRO_DIR));
    assert.deepEqual(missingRequiredKeys('---\ntitle: "T"\ndescription: "D"\ndate: 2026-11-22\n---\nBody', c), ['author', 'category', 'cover', 'excerpt']);
    assert.deepEqual(missingRequiredKeys(post(['cover:', '  kind: agent']), c), []);
  });
  test('fewer than three siblings prove nothing: no key is required', async () => {
    const two = { 'src/content.config.ts': 'x', 'src/content/blog/a.md': ASTRO_DIR['src/content/blog/a.md'], 'src/content/blog/b.md': ASTRO_DIR['src/content/blog/b.md'] };
    assert.deepEqual((await deriveNewContentContract(SITE, dir, depsFor(two))).requiredKeys, []);
  });
});

describe('deriveNewContentContract — a site WITHOUT a build-time schema is never held to its siblings\' shared keys', () => {
  test('zunkireelabs-web style blog: posts share readTime/authorId, its template does not need them, so nothing is required', async () => {
    const files = { ...REAL_BLOG_DIR, 'src/blog/third.md': REAL_BLOG_DIR['src/blog/how-to-choose-ai-development-company.md'] };
    const c = await deriveNewContentContract(SITE, { dir: 'src/blog', extension: '.md' }, depsFor(files));
    assert.equal(c.schemaValidated, false);
    assert.deepEqual(c.requiredKeys, []);
    assert.deepEqual(missingRequiredKeys('---\ntitle: "x"\n---\n', c), []);
  });
});

describe('betterBlogDirectory (blog target must be the folder the real posts live in)', () => {
  const posts = (dir, n, ext = '.md') => Array.from({ length: n }, (_, i) => `${dir}/post-${i}${ext}`);
  test('Chayce shape: configured "docs" but 68 posts in src/blog -> points at src/blog', () => {
    const files = [...posts('docs', 9), ...posts('src/blog', 68), 'src/blog/blog.json', 'src/_includes/blog-post.njk'];
    assert.deepEqual(betterBlogDirectory(files, { dir: 'docs', extension: '.md' }), { dir: 'src/blog', files: 68, extension: '.md' });
  });
  test('a configured folder already named like a blog is never second-guessed', () => {
    const files = [...posts('src/blog', 5), ...posts('src/articles', 40)];
    assert.equal(betterBlogDirectory(files, { dir: 'src/blog', extension: '.md' }), null);
  });
  test('a blog-named folder with fewer than 3 files, or fewer than the configured folder, is not proposed', () => {
    assert.equal(betterBlogDirectory([...posts('docs', 9), ...posts('src/blog', 2)], { dir: 'docs', extension: '.md' }), null);
    assert.equal(betterBlogDirectory([...posts('content', 20), ...posts('src/blog', 5)], { dir: 'content', extension: '.md' }), null);
  });
  test('two equally likely blog folders is ambiguous: no objection', () => {
    assert.equal(betterBlogDirectory([...posts('docs', 2), ...posts('src/blog', 6), ...posts('src/news', 6)], { dir: 'docs', extension: '.md' }), null);
  });
  test('plumbing folders and index files never count; no evidence means no objection', () => {
    assert.equal(betterBlogDirectory([...posts('docs', 1), ...posts('src/_blog', 9), ...posts('.github/blog', 9)], { dir: 'docs', extension: '.md' }), null);
    assert.equal(betterBlogDirectory(['docs/a.md'], { dir: 'docs', extension: '.md' }), null);
    assert.equal(betterBlogDirectory(null, { dir: 'docs' }), null);
  });
});

describe('deriveNewContentContract — declaresSources', () => {
  test('true when the siblings carry a `sources:` key (Chayce shape), false when they do not', async () => {
    const mk = (extra) => ['---', 'title: "T"', 'date: "2026-01-01"', ...extra, '---', 'Body'].join('\n');
    const withSrc = Object.fromEntries(['a', 'b', 'c'].map((n) => [`src/blog/${n}.md`, mk(['sources:', '  - name: "X"', '    url: "https://www.gov.uk/x"'])]));
    const without = Object.fromEntries(['a', 'b', 'c'].map((n) => [`src/blog/${n}.md`, mk([])]));
    const dir = { dir: 'src/blog', extension: '.md' };
    assert.equal((await deriveNewContentContract(SITE, dir, depsFor(withSrc))).declaresSources, true);
    assert.equal((await deriveNewContentContract(SITE, dir, depsFor(without))).declaresSources, false);
  });
});

describe('deriveNewContentContract — a required cover no post shows in minimal form', () => {
  const dir = { dir: 'src/content/blog', extension: '.md' };
  const rich = (n) => post(['cover:', '  kind: pills', '  heading: "H"', `  words: ["${n}"]`]);
  test('is taken from the site\'s own content schema when that declares a `kind`-only variant', async () => {
    const files = {
      'src/content.config.ts': "const cover = z.discriminatedUnion('kind', [z.object({ kind: z.literal('agent') }), z.object({ kind: z.literal('pills'), heading: z.string(), words: z.array(z.string()) })]);",
      'src/content/blog/a.md': rich('a'), 'src/content/blog/b.md': rich('b'), 'src/content/blog/c.md': rich('c'),
    };
    const c = await deriveNewContentContract(SITE, dir, depsFor(files));
    assert.deepEqual(c.siblingConstants.cover, { kind: 'agent' });
  });
  test('stays unresolved (a person chooses) when the schema has no such variant', async () => {
    const files = { 'src/content.config.ts': 'export const collections = {};', 'src/content/blog/a.md': rich('a'), 'src/content/blog/b.md': rich('b'), 'src/content/blog/c.md': rich('c') };
    assert.equal((await deriveNewContentContract(SITE, dir, depsFor(files))).siblingConstants.cover, undefined);
  });
});
