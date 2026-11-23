import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeChange, isDataReady, meta } from './ts-keyed-record-fields.js';
import { getAdapter, listAdapterMeta } from './registry.js';

const OVERRIDES = `// Search-result title and description for existing content posts, keyed by post slug.
export const postSeoOverrides: Record<string, { title: string; description: string }> = {
  "ielts-vs-pte": {
    title: "IELTS vs PTE: Differences in Format, Scoring & Acceptance",
    description: "IELTS or PTE? Compare exam format, scoring and acceptance.",
  },
};
`;
const files = { 'src/data/post-seo-overrides.ts': OVERRIDES, 'src/content/blog/posts/new-post.json': '{"slug":{"current":"new-post"}}', 'src/content/blog/posts/ielts-vs-pte.json': '{}' };
const fetchFile = async (_s, path) => (path in files ? { content: files[path] } : null);

// Admizz's real routing: ONE pattern for every root slug, mapped to the shared template, with the meta-title adapter pointed at the record.
const CFG = { id: 'ts-keyed-record-fields', dataFile: 'src/data/post-seo-overrides.ts', exportName: 'postSeoOverrides', urlPattern: '^/([^/]+)/?$', allowCreateKey: true, keyEvidence: { file: 'src/content/blog/posts/{key}.json' } };
const site = (cfg = CFG) => ({ id: 8862, url_file_map: { patterns: [{ match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx', adapters: { 'meta-title': cfg } }] } });
const draft = (page, content = {}, action_type = 'meta-title') => ({ action_type, content: { page: `https://admizzeducation.com${page}`, selectedTitle: 'A Better Title for This Post', metaDescription: 'A better description for this post.', ...content } });

describe('ts-keyed-record-fields — meta-title for a post served by the shared [slug] template', () => {
  test('it is a registered adapter', async () => {
    assert.equal(meta.id, 'ts-keyed-record-fields');
    assert.ok((await listAdapterMeta()).some((m) => m.id === 'ts-keyed-record-fields'));
    assert.equal((await getAdapter('ts-keyed-record-fields')).meta.id, 'ts-keyed-record-fields');
  });

  test('updates a post that already has an override, and writes the record file, never the shared template', async () => {
    const r = await computeChange(site(), draft('/ielts-vs-pte'), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.filePath, 'src/data/post-seo-overrides.ts');
    assert.equal(r.created, false);
    assert.match(r.newContent, /title: "A Better Title for This Post",/);
    assert.match(r.newContent, /description: "A better description for this post\.",/);
    assert.deepEqual(r.changedRegions.map((c) => c.field), ['title', 'description']);
    assert.match(r.changedRegions[0].before, /IELTS vs PTE/);
  });

  test('adds an entry for a post that has none, but ONLY because the post file proves the slug is real', async () => {
    const r = await computeChange(site(), draft('/new-post'), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.created, true);
    assert.match(r.newContent, /"new-post": \{\n    title: "A Better Title for This Post",/);
    assert.ok(r.newContent.includes('"ielts-vs-pte"'), 'the existing entry is untouched');
  });

  test('a slug with no post file is not a post: refused, nothing written (a root URL that is not a blog post never reaches the shared template)', async () => {
    const r = await computeChange(site(), draft('/not-a-post'), fetchFile, 'main');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'target-not-identified');
    assert.equal(r.newContent, undefined);
  });

  test('without allowCreateKey a post with no entry is refused', async () => {
    const { allowCreateKey, ...strict } = CFG;
    const r = await computeChange(site(strict), draft('/new-post'), fetchFile, 'main');
    assert.equal(r.reason, 'target-not-identified');
  });

  test('a new entry needs both fields: a draft with no description cannot create one', async () => {
    const r = await computeChange(site(), draft('/new-post', { metaDescription: null }), fetchFile, 'main');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'draft-not-ready');
  });

  test('an existing entry with no new description keeps its own', async () => {
    const r = await computeChange(site(), draft('/ielts-vs-pte', { metaDescription: null }), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    assert.match(r.newContent, /description: "IELTS or PTE\? Compare exam format, scoring and acceptance\.",/);
    assert.deepEqual(r.changedRegions.map((c) => c.field), ['title']);
  });

  test('no title selected yet is "not ready", not a write', async () => {
    const r = await computeChange(site(), draft('/ielts-vs-pte', { selectedTitle: null }), fetchFile, 'main');
    assert.equal(r.reason, 'draft-not-ready');
  });

  test('applying the same draft twice gives identical file text', async () => {
    const first = await computeChange(site(), draft('/ielts-vs-pte'), fetchFile, 'main');
    files['src/data/post-seo-overrides.ts'] = first.newContent;
    try {
      const second = await computeChange(site(), draft('/ielts-vs-pte'), fetchFile, 'main');
      assert.equal(second.ok, true, second.error);
      assert.equal(second.newContent, first.newContent);
    } finally { files['src/data/post-seo-overrides.ts'] = OVERRIDES; }
  });

  test('a page that is not under the configured pattern, a missing data file, and an action type with no route are all refused', async () => {
    assert.equal((await computeChange(site(), draft('/category/visa/guides'), fetchFile, 'main')).ok, false);
    const noFile = await computeChange(site(), draft('/ielts-vs-pte'), async () => null, 'main');
    assert.equal(noFile.reason, 'file-not-found');
    const other = await computeChange(site(), draft('/ielts-vs-pte', {}, 'canonical'), fetchFile, 'main');
    assert.equal(other.reason, 'no-file-mapping');
  });

  test('isDataReady says yes only where a write would succeed', async () => {
    assert.equal(await isDataReady(site(), 'https://admizzeducation.com/ielts-vs-pte', CFG, fetchFile, 'main'), true);
    assert.equal(await isDataReady(site(), 'https://admizzeducation.com/new-post', CFG, fetchFile, 'main'), true);
    assert.equal(await isDataReady(site(), 'https://admizzeducation.com/not-a-post', CFG, fetchFile, 'main'), false);
    assert.equal(await isDataReady(site(), 'https://admizzeducation.com/ielts-vs-pte', { ...CFG, exportName: 'missing' }, fetchFile, 'main'), false);
  });
});
