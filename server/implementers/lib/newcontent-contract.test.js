import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveNewContentContract, frontMatterKeys } from './newcontent-contract.js';

const SITE = { id: 1, default_branch: 'main' };

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

function depsFor(files, { treeError = null, readError = null } = {}) {
  return {
    getRepoTree: async () => {
      if (treeError) throw new Error(treeError);
      return { files: Object.keys(files), truncated: false };
    },
    // Mirrors the REAL getFileContent contract deliberately: { content, sha },
    // or null when the file isn't on this ref. Returning a bare string here is
    // what let the module ship calling .match() on the envelope object — the
    // mock was the only thing that made it look like it worked.
    getFileContent: async (_site, path) => {
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
