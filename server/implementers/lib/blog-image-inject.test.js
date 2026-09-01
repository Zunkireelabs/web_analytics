import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let fileFixture; // raw file content string, or null for "not found"
let pushCalls;

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getFileContent: async () => (fileFixture == null ? null : { content: fileFixture }),
  },
});
mock.module(resolve('./github-ops.js'), {
  namedExports: {
    baseBranch: () => 'main',
    pushDraftBranch: async (site, draft, files, target) => {
      pushCalls.push({ files, target });
      return { ok: true, branchName: 'batch-branch', appliedFiles: files.map((f) => f.path) };
    },
  },
});

const { computeBlogImageMerge, pushBlogImageBranch, previewLiveBlogImage } = await import('./blog-image-inject.js');

const SITE = { id: 1 };
function draftWith(content) {
  return { content };
}

beforeEach(() => {
  fileFixture = '---\ntitle: "A Real Post"\n---\n\nBody.';
  pushCalls = [];
});

describe('computeBlogImageMerge', () => {
  const FULL_CONTENT = { filePath: 'src/blog/a.md', imageUrl: 'https://images.example/a.jpg', imageAlt: 'A field', imageCredit: 'Photo by Jane Doe on Pexels' };

  test('splices real image fields into the live front matter', async () => {
    const merged = await computeBlogImageMerge(SITE, draftWith(FULL_CONTENT));
    assert.equal(merged.ok, true);
    assert.equal(merged.filePath, 'src/blog/a.md');
    assert.match(merged.newContent, /featuredImage: "https:\/\/images\.example\/a\.jpg"/);
    assert.match(merged.newContent, /featuredImageAlt: "A field"/);
    assert.match(merged.newContent, /featuredImageCredit: "Photo by Jane Doe on Pexels"/);
    assert.match(merged.newContent, /Body\./, 'body text preserved');
  });

  test('refuses when the draft has no filePath at all', async () => {
    const merged = await computeBlogImageMerge(SITE, draftWith({ imageUrl: 'x' }));
    assert.equal(merged.ok, false);
    assert.equal(merged.reason, 'draft-not-ready');
  });

  test('refuses when the file no longer exists on the target branch', async () => {
    fileFixture = null;
    const merged = await computeBlogImageMerge(SITE, draftWith(FULL_CONTENT));
    assert.equal(merged.ok, false);
    assert.equal(merged.reason, 'file-not-found');
  });

  // The safety contract SAFE_GENERATOR_IDS depends on for autonomous
  // shipping: a post that picked up an image some other way (a human edit,
  // a different agent, an earlier day's own already-merged batch) since
  // this draft was generated must never get a second one silently appended.
  test('refuses when the live file already has a featured image — re-verified fresh, not trusted from generation time', async () => {
    fileFixture = '---\ntitle: "A Real Post"\nfeaturedImage: "/someone-else-added-this.jpg"\n---\n\nBody.';
    const merged = await computeBlogImageMerge(SITE, draftWith(FULL_CONTENT));
    assert.equal(merged.ok, false);
    assert.equal(merged.reason, 'already-has-image');
  });

  test('refuses on a raw, unresolved merge-conflict marker rather than building on corrupted content', async () => {
    fileFixture = '---\ntitle: "A Real Post"\n---\n\n<<<<<<< HEAD\nBody.\n=======\nOther body.\n>>>>>>> branch';
    const merged = await computeBlogImageMerge(SITE, draftWith(FULL_CONTENT));
    assert.equal(merged.ok, false);
    assert.equal(merged.reason, 'conflict-markers');
  });
});

describe('pushBlogImageBranch', () => {
  test('pushes the patched file when the merge succeeds', async () => {
    const content = { filePath: 'src/blog/a.md', imageUrl: 'https://images.example/a.jpg', imageAlt: 'x', imageCredit: null };
    const result = await pushBlogImageBranch(SITE, draftWith(content), { some: 'batch' }, 'main');
    assert.equal(result.ok, true);
    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].files[0].path, 'src/blog/a.md');
    assert.match(pushCalls[0].files[0].content, /featuredImage:/);
  });

  test('never pushes when the merge refuses', async () => {
    fileFixture = null;
    const content = { filePath: 'src/blog/gone.md', imageUrl: 'x', imageAlt: 'x', imageCredit: null };
    const result = await pushBlogImageBranch(SITE, draftWith(content), {}, 'main');
    assert.equal(result.ok, false);
    assert.equal(pushCalls.length, 0);
  });
});

describe('previewLiveBlogImage', () => {
  test('returns a real before/after diff, never pushing anything', async () => {
    const content = { filePath: 'src/blog/a.md', imageUrl: 'https://images.example/a.jpg', imageAlt: 'x', imageCredit: null };
    const result = await previewLiveBlogImage(SITE, draftWith(content));
    assert.equal(result.ok, true);
    assert.equal(result.live, true);
    assert.equal(result.changedRegions[0].before, fileFixture);
    assert.match(result.changedRegions[0].after, /featuredImage:/);
    assert.equal(pushCalls.length, 0);
  });
});
