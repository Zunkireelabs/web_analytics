import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let siteFixture;
let fileFixture; // raw file content string, or null for "not found"
let searchImageResult; // what pexels-client's searchImage returns
let pexelsConfigured;

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteFixture },
});
mock.module(resolve('../github/client.js'), {
  namedExports: {
    getFileContent: async () => (fileFixture == null ? null : { content: fileFixture }),
    defaultBranchName: (site) => site.repo_default_branch || 'main',
  },
});
mock.module(resolve('./lib/pexels-client.js'), {
  namedExports: {
    configured: () => pexelsConfigured,
    searchImage: async () => searchImageResult,
    buildImageQueries: ({ title }) => [title],
  },
});
mock.module(resolve('./lib/blog-image-usage.js'), {
  namedExports: { usedPhotoIds: async () => new Set() },
});

const { generate, meta } = await import('./blog-image.js');

beforeEach(() => {
  siteFixture = { id: 1, repo_owner: 'acme', repo_name: 'acme-web' };
  fileFixture = '---\ntitle: "A Real Post Title"\n---\n\nBody.';
  searchImageResult = { url: 'https://images.example/a.jpg', alt: 'A field', photographer: 'Jane Doe' };
  pexelsConfigured = true;
});

describe('blog-image generator', () => {
  test('meta.id is blog-image', () => {
    assert.equal(meta.id, 'blog-image');
  });

  test('requires filePath', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }));
  });

  test('refuses when image search is not configured, rather than drafting something that can never apply', async () => {
    pexelsConfigured = false;
    await assert.rejects(
      () => generate({ siteId: 1, params: { filePath: 'src/blog/a.md' } }),
      /not configured/i,
    );
  });

  test('refuses when the post already has a featured image — the recommendation is stale', async () => {
    fileFixture = '---\ntitle: "A Real Post Title"\nfeaturedImage: "/already.jpg"\n---\n\nBody.';
    await assert.rejects(
      () => generate({ siteId: 1, params: { filePath: 'src/blog/a.md' } }),
      /already has a featured image/i,
    );
  });

  test('refuses when the file has no real title in front matter', async () => {
    fileFixture = '---\ndescription: "no title here"\n---\n\nBody.';
    await assert.rejects(
      () => generate({ siteId: 1, params: { filePath: 'src/blog/a.md' } }),
      /could not find a real title/i,
    );
  });

  test('refuses with no good relevance match, rather than forcing a weak one', async () => {
    searchImageResult = null;
    await assert.rejects(
      () => generate({ siteId: 1, params: { filePath: 'src/blog/a.md' } }),
      /no relevant real image/i,
    );
  });

  test('produces real image fields from a confirmed match, grounded in the post\'s own title', async () => {
    const { content, summary } = await generate({ siteId: 1, params: { filePath: 'src/blog/a.md' } });
    assert.equal(content.filePath, 'src/blog/a.md');
    assert.equal(content.title, 'A Real Post Title');
    assert.equal(content.imageUrl, 'https://images.example/a.jpg');
    assert.equal(content.imageAlt, 'A field');
    assert.equal(content.imageCredit, 'Photo by Jane Doe on Pexels');
    assert.match(summary, /A Real Post Title/);
  });

  test('falls back to the post title as alt text when Pexels has none', async () => {
    searchImageResult = { url: 'https://images.example/b.jpg', alt: '', photographer: null };
    const { content } = await generate({ siteId: 1, params: { filePath: 'src/blog/a.md' } });
    assert.equal(content.imageAlt, 'A Real Post Title');
    assert.equal(content.imageCredit, null, 'no credit line invented when Pexels gives no photographer');
  });
});
