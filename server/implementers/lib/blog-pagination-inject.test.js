import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// github-ops/client are not imported by the functions under test when deps are passed, but the module imports them at load time.
// They are stubbed with the names the module needs so the real GitHub client (unloadable under the module-mock loader here) is not used.
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
const resolve = (p) => new URL(p, import.meta.url).href;
const names = (rel) => [...readFileSync(new URL(rel, import.meta.url), 'utf8').matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
const stub = (rel) => Object.fromEntries(names(rel).map((n) => [n, async () => { throw new Error(`${n} must not be reached`); }]));
mock.module(resolve('../../github/client.js'), { namedExports: stub('../../github/client.js') });
mock.module(resolve('./github-ops.js'), { namedExports: { ...stub('./github-ops.js'), baseBranch: () => 'main' } });
mock.module(resolve('../../llm.js'), { namedExports: stub('../../llm.js') });
const { computeBlogPaginationMerge, pushBlogPaginationBranch, previewLiveBlogPagination } = await import('./blog-pagination-inject.js');

const site = { id: 1, repo_default_branch: 'main' };
const BEFORE = '---\ntitle: "Blog"\n---\n{% for post in collections.blog %}x{% endfor %}\n';
const AFTER = '---\ntitle: "Blog"\npagination:\n  data: collections.blog\n---\n{% for post in pagedPosts %}x{% endfor %}\n';
const draft = (over = {}) => ({ action_type: 'blog-pagination', content: { listing: 'https://x.test/blog/', files: [{ path: 'src/blog/index.njk', before: BEFORE, after: AFTER }], ...over } });
const repo = (files) => ({ getFileContent: async (_s, path) => (path in files ? { content: files[path] } : null) });

describe('computeBlogPaginationMerge', () => {
  test('a file the recipe creates (before: null) is written only when nothing exists at that path', async () => {
    const d = draft({ files: [
      { path: 'src/pages/blog/index.astro', before: BEFORE, after: AFTER },
      { path: 'src/pages/blog/page/[page].astro', before: null, after: '---\n---\n<Listing />\n' },
    ] });
    const ok = await computeBlogPaginationMerge(site, d, 'main', repo({ 'src/pages/blog/index.astro': BEFORE }));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.files.map((f) => f.path), ['src/pages/blog/index.astro', 'src/pages/blog/page/[page].astro']);
    assert.equal(ok.files[1].oldContent, '');
    assert.equal(ok.filePath, 'src/pages/blog/index.astro');
    const clash = await computeBlogPaginationMerge(site, d, 'main', repo({ 'src/pages/blog/index.astro': BEFORE, 'src/pages/blog/page/[page].astro': 'someone made this' }));
    assert.equal(clash.ok, false);
    assert.equal(clash.reason, 'source-changed');
    assert.match(clash.error, /was not overwritten/);
  });
  test('writes the planned content when the file is exactly what the draft was planned from', async () => {
    const r = await computeBlogPaginationMerge(site, draft(), 'main', repo({ 'src/blog/index.njk': BEFORE }));
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/blog/index.njk');
    assert.equal(r.newContent, AFTER);
    assert.equal(r.oldContent, BEFORE);
  });
  test('refuses, writing nothing, when the file changed since the draft was generated', async () => {
    const r = await computeBlogPaginationMerge(site, draft(), 'main', repo({ 'src/blog/index.njk': `${BEFORE}<!-- someone edited this -->\n` }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'source-changed');
    assert.match(r.error, /Regenerate the draft/);
  });
  test('line endings alone are not a change', async () => {
    const r = await computeBlogPaginationMerge(site, draft(), 'main', repo({ 'src/blog/index.njk': BEFORE.replace(/\n/g, '\r\n') }));
    assert.equal(r.ok, true);
  });
  test('refuses a missing file', async () => {
    const r = await computeBlogPaginationMerge(site, draft(), 'main', repo({}));
    assert.equal(r.reason, 'file-not-found');
  });
  test('refuses a file with merge-conflict markers', async () => {
    const r = await computeBlogPaginationMerge(site, draft(), 'main', repo({ 'src/blog/index.njk': `<<<<<<< HEAD\n${BEFORE}=======\n>>>>>>> x\n` }));
    assert.equal(r.ok, false);
  });
  test('a draft with no planned files is not ready', async () => {
    for (const bad of [{ files: [] }, { files: [{ path: 'a' }] }, { files: null }]) {
      assert.equal((await computeBlogPaginationMerge(site, draft(bad), 'main', repo({}))).reason, 'draft-not-ready');
    }
  });
});

describe('pushBlogPaginationBranch', () => {
  test('pushes exactly the planned files, once', async () => {
    const pushed = [];
    const r = await pushBlogPaginationBranch(site, draft(), { batch: 1 }, 'main', { ...repo({ 'src/blog/index.njk': BEFORE }), pushDraftBranch: async (_s, _d, list, batch) => { pushed.push({ list, batch }); return { ok: true }; } });
    assert.equal(r.ok, true);
    assert.deepEqual(pushed, [{ list: [{ path: 'src/blog/index.njk', content: AFTER }], batch: { batch: 1 } }]);
  });
  test('pushes nothing when the source changed', async () => {
    let calls = 0;
    const r = await pushBlogPaginationBranch(site, draft(), {}, 'main', { ...repo({ 'src/blog/index.njk': 'different' }), pushDraftBranch: async () => { calls++; return { ok: true }; } });
    assert.equal(r.reason, 'source-changed');
    assert.equal(calls, 0);
  });
});

describe('previewLiveBlogPagination', () => {
  test('shows the live file and whether it is still the one the draft was planned from', async () => {
    const same = await previewLiveBlogPagination(site, draft(), repo({ 'src/blog/index.njk': BEFORE }));
    assert.equal(same.ok, true);
    assert.equal(same.changedRegions[0].stillPlannedFrom, true);
    assert.equal(same.changedRegions[0].alreadyPaginated, false);
    const done = await previewLiveBlogPagination(site, draft(), repo({ 'src/blog/index.njk': AFTER }));
    assert.equal(done.changedRegions[0].alreadyPaginated, true);
  });
  test('a missing file is reported', async () => assert.equal((await previewLiveBlogPagination(site, draft(), repo({}))).reason, 'file-not-found'));
});
