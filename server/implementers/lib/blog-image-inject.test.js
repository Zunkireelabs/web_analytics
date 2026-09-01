import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let fileFixture; // raw post-file content string, or null for "not found"
let imageFileFixture; // truthy when the local image path is already committed on the branch
let pushCalls;

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getFileContent: async (site, path) => {
      if (path.startsWith('images/blog/')) return imageFileFixture ? { content: 'x', sha: 'img-sha' } : null;
      return fileFixture == null ? null : { content: fileFixture };
    },
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

// A configured blog-outline target is what makes a local image path
// resolvable at all (url-file-map.js's resolveBlogImagePath) — a site with
// none is covered separately below.
const SITE = { id: 1, url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } } };
function draftWith(content) {
  return { content };
}

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
let originalFetch;

beforeEach(() => {
  fileFixture = '---\ntitle: "A Real Post"\n---\n\nBody.';
  imageFileFixture = false;
  pushCalls = [];
  originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => JPEG_BYTES.buffer.slice(JPEG_BYTES.byteOffset, JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength),
  });
});

afterEach(() => { global.fetch = originalFetch; });

describe('computeBlogImageMerge', () => {
  const FULL_CONTENT = { filePath: 'src/blog/a.md', title: 'A Real Post', imageUrl: 'https://images.example/a.jpg', imageAlt: 'A field', imageCredit: 'Photo by Jane Doe on Pexels' };

  test('splices the LOCAL repo path (not the remote url) into the live front matter, plus featuredImageSource for dedup', async () => {
    const merged = await computeBlogImageMerge(SITE, draftWith(FULL_CONTENT));
    assert.equal(merged.ok, true);
    assert.equal(merged.filePath, 'src/blog/a.md');
    assert.match(merged.newContent, /featuredImage: "\/images\/blog\/a-real-post\.jpg"/);
    assert.match(merged.newContent, /featuredImageAlt: "A field"/);
    assert.match(merged.newContent, /featuredImageCredit: "Photo by Jane Doe on Pexels"/);
    assert.match(merged.newContent, /featuredImageSource: "https:\/\/images\.example\/a\.jpg"/);
    assert.match(merged.newContent, /Body\./, 'body text preserved');
    assert.equal(merged.repoImagePath, 'images/blog/a-real-post.jpg');
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

  describe('mode: duplicate', () => {
    const DUP_CONTENT = { ...FULL_CONTENT, mode: 'duplicate' };

    test('replaces the existing image fields in place, never leaving a stale credit line', async () => {
      fileFixture = '---\ntitle: "A Real Post"\nfeaturedImage: "https://old.example/a.jpg"\nfeaturedImageCredit: "Photo by Old Photographer"\n---\n\nBody.';
      const merged = await computeBlogImageMerge(SITE, draftWith(DUP_CONTENT));
      assert.equal(merged.ok, true);
      assert.equal((merged.newContent.match(/featuredImage:/g) || []).length, 1, 'must not leave two featuredImage lines');
      assert.match(merged.newContent, /featuredImage: "\/images\/blog\/a-real-post\.jpg"/);
      assert.ok(!merged.newContent.includes('Old Photographer'), 'stale credit for the replaced photo must not survive');
    });

    test('refuses when the live file no longer has an image to replace — re-verified fresh, not trusted from generation time', async () => {
      fileFixture = '---\ntitle: "A Real Post"\n---\n\nBody.';
      const merged = await computeBlogImageMerge(SITE, draftWith(DUP_CONTENT));
      assert.equal(merged.ok, false);
      assert.equal(merged.reason, 'no-longer-duplicate');
    });
  });
});

describe('pushBlogImageBranch', () => {
  test('pushes the patched post AND the downloaded image, in the same commit', async () => {
    const content = { filePath: 'src/blog/a.md', title: 'A Real Post', imageUrl: 'https://images.example/a.jpg', imageAlt: 'x', imageCredit: null };
    const result = await pushBlogImageBranch(SITE, draftWith(content), { some: 'batch' }, 'main');
    assert.equal(result.ok, true);
    assert.equal(pushCalls.length, 1);
    const [postFile, imageFile] = pushCalls[0].files;
    assert.equal(postFile.path, 'src/blog/a.md');
    assert.match(postFile.content, /featuredImage: "\/images\/blog\/a-real-post\.jpg"/);
    assert.equal(imageFile.path, 'images/blog/a-real-post.jpg');
    assert.ok(Buffer.isBuffer(imageFile.contentBuffer));
  });

  test('the image is already committed (a retry/rerun) — skipped, only the post file is pushed', async () => {
    imageFileFixture = true;
    let fetchCalled = false;
    const passThrough = global.fetch;
    global.fetch = async (...args) => { fetchCalled = true; return passThrough(...args); };
    const content = { filePath: 'src/blog/a.md', title: 'A Real Post', imageUrl: 'https://images.example/a.jpg', imageAlt: 'x', imageCredit: null };
    const result = await pushBlogImageBranch(SITE, draftWith(content), {}, 'main');
    assert.equal(result.ok, true);
    assert.equal(pushCalls[0].files.length, 1, 'no duplicate image file pushed');
    assert.equal(fetchCalled, false, 'never re-downloads an image already on the branch');
  });

  test('the download fails — nothing is pushed at all, since this draft only exists to add/replace an image', async () => {
    global.fetch = async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
    const content = { filePath: 'src/blog/a.md', title: 'A Real Post', imageUrl: 'https://images.example/a.jpg', imageAlt: 'x', imageCredit: null };
    const result = await pushBlogImageBranch(SITE, draftWith(content), {}, 'main');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'image-download-failed');
    assert.equal(pushCalls.length, 0);
  });

  test('never pushes when the merge refuses', async () => {
    fileFixture = null;
    const content = { filePath: 'src/blog/gone.md', title: 'Gone', imageUrl: 'x', imageAlt: 'x', imageCredit: null };
    const result = await pushBlogImageBranch(SITE, draftWith(content), {}, 'main');
    assert.equal(result.ok, false);
    assert.equal(pushCalls.length, 0);
  });
});

describe('previewLiveBlogImage', () => {
  test('returns a real before/after diff, never pushing anything', async () => {
    const content = { filePath: 'src/blog/a.md', title: 'A Real Post', imageUrl: 'https://images.example/a.jpg', imageAlt: 'x', imageCredit: null };
    const result = await previewLiveBlogImage(SITE, draftWith(content));
    assert.equal(result.ok, true);
    assert.equal(result.live, true);
    assert.equal(result.changedRegions[0].before, fileFixture);
    assert.match(result.changedRegions[0].after, /featuredImage:/);
    assert.equal(pushCalls.length, 0);
  });
});
