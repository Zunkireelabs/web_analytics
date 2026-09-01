import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let siteFixture;
let treeFiles;
let filesByPath; // path -> raw content string
let pexelsConfigured;

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteFixture },
});
mock.module(resolve('../github/client.js'), {
  namedExports: {
    getRepoTree: async () => ({ files: treeFiles }),
    getFileContent: async (site, path) => (filesByPath[path] != null ? { content: filesByPath[path] } : null),
    defaultBranchName: (site) => site.repo_default_branch || 'main',
  },
});
mock.module(resolve('../generators/lib/pexels-client.js'), {
  namedExports: {
    configured: () => pexelsConfigured,
    // Real implementation (not a stub) — this is exactly what the agent
    // uses to group posts by photo id, so a fake here would defeat the
    // duplicate-detection tests below.
    pexelsPhotoIdFromUrl: (url) => {
      const m = /\/photos\/(\d+)\//.exec(url || '');
      return m ? Number(m[1]) : null;
    },
  },
});

const { run, meta } = await import('./blog-image.js');

// `image` true/false: no image field vs. a real, remote non-Pexels image
// (never a duplicate match, always assumed to exist — a remote URL can't be
// verified without a network call). `photoId`: a real Pexels photo id, for
// the duplicate-detection tests, which two posts can share on purpose.
// `localAsset`: a local repo-relative path, for the broken-asset tests —
// caller decides whether that exact path is also added to treeFiles.
function post(title, { image = false, photoId, localAsset } = {}) {
  let url;
  if (photoId != null) url = `https://images.pexels.com/photos/${photoId}/x.jpeg`;
  else if (localAsset) url = localAsset;
  else if (image) url = 'https://example.com/real-image.jpg';
  const imageLine = url ? `featuredImage: "${url}"\n` : '';
  return `---\ntitle: "${title}"\n${imageLine}---\n\nBody.`;
}

beforeEach(() => {
  siteFixture = {
    id: 1, repo_owner: 'acme', repo_name: 'acme-web',
    url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } },
  };
  treeFiles = [];
  filesByPath = {};
  pexelsConfigured = true;
});

describe('blog-image agent', () => {
  test('meta.id is blog-image', () => {
    assert.equal(meta.id, 'blog-image');
  });

  test('insufficient-data when image search is not configured at all', async () => {
    pexelsConfigured = false;
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('insufficient-data when no repo is connected', async () => {
    siteFixture = { id: 1, repo_owner: null, repo_name: null };
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('insufficient-data when no blog directory is configured', async () => {
    siteFixture = { id: 1, repo_owner: 'acme', repo_name: 'acme-web', url_file_map: {} };
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('flags a post with no image field at all, carrying its real filePath', async () => {
    treeFiles = ['src/blog/no-image.md'];
    filesByPath = { 'src/blog/no-image.md': post('A Post With No Image') };
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].recommendedAction.generatorId, 'blog-image');
    assert.equal(result.facts.findings[0].recommendedAction.params.filePath, 'src/blog/no-image.md');
    assert.equal(result.facts.findings[0].evidence.title, 'A Post With No Image');
  });

  test('never flags a post that already has an image', async () => {
    treeFiles = ['src/blog/has-image.md'];
    filesByPath = { 'src/blog/has-image.md': post('Already Imaged', { image: true }) };
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 0);
  });

  test('skips the directory index and files with the wrong extension', async () => {
    treeFiles = ['src/blog/index.md', 'src/blog/notes.txt', 'src/blog/_data.md', 'src/blog/sub/nested.md'];
    filesByPath = {
      'src/blog/index.md': post('Index'),
      'src/blog/_data.md': post('Data file'),
      'src/blog/sub/nested.md': post('Nested'),
    };
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 0, 'index/underscore-prefixed/nested/wrong-extension files must never be treated as real posts');
  });

  test('skips a file with no real title, even with no image field', async () => {
    treeFiles = ['src/blog/no-title.md'];
    filesByPath = { 'src/blog/no-title.md': '---\ndescription: "no title"\n---\n\nBody.' };
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 0);
  });

  test('does NOT call Pexels at detection time — that only happens at generation time', async () => {
    treeFiles = ['src/blog/a.md'];
    filesByPath = { 'src/blog/a.md': post('A Post') };
    // If detection tried to search images, it would need searchImage/buildImageQueries,
    // which are not mocked here at all — an unmocked call would throw and fail this test.
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 1);
  });

  test('multiple qualifying posts each get their own finding', async () => {
    treeFiles = ['src/blog/a.md', 'src/blog/b.md'];
    filesByPath = { 'src/blog/a.md': post('Post A'), 'src/blog/b.md': post('Post B') };
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 2);
    const filePaths = result.facts.findings.map((f) => f.recommendedAction.params.filePath).sort();
    assert.deepEqual(filePaths, ['src/blog/a.md', 'src/blog/b.md']);
  });

  describe('duplicate-photo detection', () => {
    test('flags every post after the first sharing a real Pexels photo id, keeping the first untouched', async () => {
      treeFiles = ['src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md'];
      filesByPath = {
        'src/blog/a.md': post('Post A', { photoId: 4604607 }),
        'src/blog/b.md': post('Post B', { photoId: 4604607 }),
        'src/blog/c.md': post('Post C', { photoId: 4604607 }),
      };
      const result = await run({ siteId: 1 });
      const filePaths = result.facts.findings.map((f) => f.recommendedAction.params.filePath).sort();
      assert.deepEqual(filePaths, ['src/blog/b.md', 'src/blog/c.md'], 'the first occurrence keeps its image untouched');
      for (const f of result.facts.findings) {
        assert.equal(f.recommendedAction.params.mode, 'duplicate');
      }
    });

    test('never flags posts whose images are genuinely different photo ids', async () => {
      treeFiles = ['src/blog/a.md', 'src/blog/b.md'];
      filesByPath = {
        'src/blog/a.md': post('Post A', { photoId: 111 }),
        'src/blog/b.md': post('Post B', { photoId: 222 }),
      };
      const result = await run({ siteId: 1 });
      assert.equal(result.facts.findings.length, 0);
    });

    test('never flags a shared non-Pexels image as a duplicate — nothing here can safely judge that a match', async () => {
      treeFiles = ['src/blog/a.md', 'src/blog/b.md'];
      filesByPath = {
        'src/blog/a.md': post('Post A', { image: true }),
        'src/blog/b.md': post('Post B', { image: true }),
      };
      const result = await run({ siteId: 1 });
      assert.equal(result.facts.findings.length, 0);
    });

    test('missing-image findings and duplicate findings can both appear in the same run', async () => {
      treeFiles = ['src/blog/no-image.md', 'src/blog/dup-a.md', 'src/blog/dup-b.md'];
      filesByPath = {
        'src/blog/no-image.md': post('No Image'),
        'src/blog/dup-a.md': post('Dup A', { photoId: 999 }),
        'src/blog/dup-b.md': post('Dup B', { photoId: 999 }),
      };
      const result = await run({ siteId: 1 });
      const modes = result.facts.findings.map((f) => f.recommendedAction.params.mode ?? 'missing').sort();
      assert.deepEqual(modes, ['duplicate', 'missing']);
    });
  });

  describe('broken local-asset detection', () => {
    test('flags a post whose featuredImage names a local file that was never committed', async () => {
      treeFiles = ['src/blog/a.md']; // note: the asset itself is NOT in the tree
      filesByPath = { 'src/blog/a.md': post('Post A', { localAsset: '/assets/images/blog/missing.jpg' }) };
      const result = await run({ siteId: 1 });
      assert.equal(result.facts.findings.length, 1);
      assert.equal(result.facts.findings[0].recommendedAction.params.mode, 'broken');
      assert.equal(result.facts.findings[0].recommendedAction.params.filePath, 'src/blog/a.md');
    });

    test('never flags a local asset path that really is in the repo tree', async () => {
      treeFiles = ['src/blog/a.md', 'assets/images/blog/real.jpg'];
      filesByPath = { 'src/blog/a.md': post('Post A', { localAsset: '/assets/images/blog/real.jpg' }) };
      const result = await run({ siteId: 1 });
      assert.equal(result.facts.findings.length, 0);
    });

    test('never flags a remote URL as broken — nothing here can verify it without a network call', async () => {
      treeFiles = ['src/blog/a.md'];
      filesByPath = { 'src/blog/a.md': post('Post A', { image: true }) };
      const result = await run({ siteId: 1 });
      assert.equal(result.facts.findings.length, 0);
    });
  });
});
