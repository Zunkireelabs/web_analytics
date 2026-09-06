import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixCollectionSelfInclusion } from './fix-collection-self-inclusion.js';

async function makeRepo(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'collection-fix-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

const BLOG_JSON = '{\n  "layout": "blog-post.njk",\n  "tags": ["blog"],\n  "permalink": "/blog/{{ page.fileSlug }}/"\n}';

describe('fixCollectionSelfInclusion', () => {
  test('the real zunkireelabs.com shape: adds the flag when the index has no opt-out', async () => {
    const repo = await makeRepo({
      'src/blog/blog.json': BLOG_JSON,
      'src/blog/index.njk': '---\nlayout: base.njk\ntitle: "AI & Technology Blog"\npermalink: /blog/\n---\n<h1>Blog</h1>',
    });
    const result = await fixCollectionSelfInclusion(repo, 'src/blog', { write: true });
    assert.equal(result.fixed, true);
    const raw = await readFile(path.join(repo, 'src/blog/index.njk'), 'utf8');
    assert.match(raw, /eleventyExcludeFromCollections: true/);
    // Nothing else in the front matter or body changed.
    assert.match(raw, /title: "AI & Technology Blog"/);
    assert.match(raw, /<h1>Blog<\/h1>$/);
    await rm(repo, { recursive: true, force: true });
  });

  test('idempotent — a second run makes no further change', async () => {
    const repo = await makeRepo({
      'src/blog/blog.json': BLOG_JSON,
      'src/blog/index.njk': '---\nlayout: base.njk\npermalink: /blog/\n---\nbody',
    });
    await fixCollectionSelfInclusion(repo, 'src/blog', { write: true });
    const once = await readFile(path.join(repo, 'src/blog/index.njk'), 'utf8');
    const second = await fixCollectionSelfInclusion(repo, 'src/blog', { write: true });
    assert.equal(second.fixed, false);
    assert.equal(second.reason, 'already-excluded');
    const twice = await readFile(path.join(repo, 'src/blog/index.njk'), 'utf8');
    assert.equal(once, twice);
    await rm(repo, { recursive: true, force: true });
  });

  test('leaves an index that already declares its own tags alone', async () => {
    const repo = await makeRepo({
      'src/blog/blog.json': BLOG_JSON,
      'src/blog/index.njk': '---\nlayout: base.njk\ntags:\n  - listing\npermalink: /blog/\n---\nbody',
    });
    const result = await fixCollectionSelfInclusion(repo, 'src/blog', { write: true });
    assert.equal(result.fixed, false);
    assert.equal(result.reason, 'already-excluded');
  });

  test('no-op when the directory data file assigns no tags', async () => {
    const repo = await makeRepo({
      'src/resources/resources.json': '{ "layout": "base.njk" }',
      'src/resources/index.njk': '---\ntitle: "Resources"\n---\nbody',
    });
    const result = await fixCollectionSelfInclusion(repo, 'src/resources', { write: true });
    assert.equal(result.fixed, false);
    assert.equal(result.reason, 'directory-data-has-no-tags');
  });

  test('no-op when the directory has no directory-data file at all', async () => {
    const repo = await makeRepo({ 'src/pages/index.njk': '---\ntitle: "X"\n---\nbody' });
    const result = await fixCollectionSelfInclusion(repo, 'src/pages', { write: true });
    assert.equal(result.fixed, false);
    assert.equal(result.reason, 'no-directory-data-file');
  });

  test('no-op when there is no index file to fix', async () => {
    const repo = await makeRepo({
      'src/blog/blog.json': BLOG_JSON,
      'src/blog/some-post.md': '---\ntitle: "X"\n---\nbody',
    });
    const result = await fixCollectionSelfInclusion(repo, 'src/blog', { write: true });
    assert.equal(result.fixed, false);
    assert.equal(result.reason, 'no-index-file');
  });

  test('dry run (write: false) reports the fix but does not write it', async () => {
    const repo = await makeRepo({
      'src/blog/blog.json': BLOG_JSON,
      'src/blog/index.njk': '---\nlayout: base.njk\npermalink: /blog/\n---\nbody',
    });
    const result = await fixCollectionSelfInclusion(repo, 'src/blog', { write: false });
    assert.equal(result.fixed, true);
    const raw = await readFile(path.join(repo, 'src/blog/index.njk'), 'utf8');
    assert.doesNotMatch(raw, /eleventyExcludeFromCollections/);
    await rm(repo, { recursive: true, force: true });
  });

  test('a missing directory is reported, not thrown', async () => {
    const repo = await makeRepo({});
    const result = await fixCollectionSelfInclusion(repo, 'src/nope', { write: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'directory-not-found');
    await rm(repo, { recursive: true, force: true });
  });
});
