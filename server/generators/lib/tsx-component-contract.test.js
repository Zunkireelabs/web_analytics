import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkGeneratedComponentContract, candidatePaths, isDirectoryRouted, missingPropMentions } from './tsx-component-contract.js';

const site = (over = {}) => ({
  repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main',
  url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/app/blogs', filename: 'page.tsx' } } },
  ...over,
});

describe('checkGeneratedComponentContract', () => {
  test('a flat-file (Markdown) tenant is not applicable — null, no repo read', async () => {
    let reads = 0;
    const r = await checkGeneratedComponentContract(site({ url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog' } } } }), 'blog-outline', { getFile: async () => { reads++; return null; } });
    assert.equal(r, null);
    assert.equal(reads, 0);
  });

  test('an action with no shared component is not applicable', async () => {
    assert.equal(await checkGeneratedComponentContract(site(), 'faq', { getFile: async () => null }), null);
  });

  test('no repo connected means could-not-check, never a refusal', async () => {
    assert.equal(await checkGeneratedComponentContract(site({ repo_owner: null }), 'blog-outline', { getFile: async () => null }), null);
  });

  test('a component that exists passes', async () => {
    const getFile = async (s, path) => (path === 'src/components/GeneratedBlogPost.tsx'
      ? { content: 'export default function X({title,slug,sections,featuredImage,categories,publishedAt}){}' } : null);
    assert.deepEqual(await checkGeneratedComponentContract(site(), 'blog-outline', { getFile }), { ok: true });
  });

  test('a component at the repo root (no src/) is found too', async () => {
    const getFile = async (s, path) => (path === 'components/GeneratedBlogPost.tsx' ? { content: 'title slug sections featuredImage categories publishedAt' } : null);
    assert.equal((await checkGeneratedComponentContract(site(), 'blog-outline', { getFile })).ok, true);
  });

  test('a genuinely absent component refuses BEFORE generation, with the reason', async () => {
    const r = await checkGeneratedComponentContract(site(), 'blog-outline', { getFile: async () => null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'component-missing');
    assert.match(r.detail, /GeneratedBlogPost/);
    assert.match(r.detail, /client's own design/);
  });

  test('a fetch error anywhere means "not found" cannot be trusted, so it is null, not a refusal', async () => {
    let n = 0;
    const getFile = async () => { if (n++ === 2) throw new Error('502'); return null; };
    assert.equal(await checkGeneratedComponentContract(site(), 'blog-outline', { getFile }), null);
  });

  test('props the component never mentions are a warning, not a refusal', async () => {
    const getFile = async (s, path) => (path.endsWith('GeneratedBlogPost.tsx') && path.startsWith('src') ? { content: 'title sections' } : null);
    const r = await checkGeneratedComponentContract(site(), 'blog-outline', { getFile });
    assert.equal(r.ok, true);
    assert.match(r.warnings[0], /slug, featuredImage, categories, publishedAt/);
  });
});

test('helpers', () => {
  assert.ok(candidatePaths('X').includes('src/components/X.tsx'));
  assert.equal(isDirectoryRouted(site(), 'blog-outline'), true);
  assert.deepEqual(missingPropMentions('foo bar', ['foo', 'baz']), ['baz']);
  // a prop name inside a longer word is not a mention
  assert.deepEqual(missingPropMentions('titleCase', ['title']), ['title']);
});
