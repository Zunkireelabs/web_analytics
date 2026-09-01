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
  namedExports: { configured: () => pexelsConfigured },
});

const { run, meta } = await import('./blog-image.js');

function post(title, { image = false } = {}) {
  return `---\ntitle: "${title}"\n${image ? 'featuredImage: "/x.jpg"\n' : ''}---\n\nBody.`;
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
});
