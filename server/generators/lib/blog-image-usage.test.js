import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let filesFixture;
let contentByPath;

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getRepoTree: async () => ({ files: filesFixture }),
    getFileContent: async (site, path) => (contentByPath[path] ? { content: contentByPath[path] } : null),
    defaultBranchName: (site) => site.repo_default_branch || 'main',
  },
});

const { usedPhotoIds } = await import('./blog-image-usage.js');

const SITE = { url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } } };

describe('usedPhotoIds', () => {
  test('collects photo ids already used across every real post in the blog dir', async () => {
    filesFixture = ['src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md'];
    contentByPath = {
      'src/blog/a.md': '---\ntitle: "A"\nfeaturedImage: "https://images.pexels.com/photos/10/x.jpeg?w=1260"\n---\nbody',
      'src/blog/b.md': '---\ntitle: "B"\nimage: "https://images.pexels.com/photos/20/y.jpeg"\n---\nbody',
      'src/blog/c.md': '---\ntitle: "C"\n---\nbody', // no image field
    };
    const ids = await usedPhotoIds(SITE);
    assert.deepEqual([...ids].sort(), [10, 20]);
  });

  test('empty set when no blog directory is configured', async () => {
    const ids = await usedPhotoIds({});
    assert.equal(ids.size, 0);
  });

  test('empty set (not a throw) when the repo scan fails', async () => {
    filesFixture = undefined; // getRepoTree destructuring { files } throws on undefined result shape below
    contentByPath = {};
    const brokenSite = { url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog' } } }, repo_default_branch: null };
    const ids = await usedPhotoIds(brokenSite);
    assert.equal(ids.size, 0);
  });
});
