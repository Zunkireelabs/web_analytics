import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

const SITE = {
  id: 1, name: 'Zunkiree Labs', repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web',
  url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } },
};

const withImage = (title) => `---\ntitle: "${title}"\nfeaturedImage: "/assets/x.jpg"\n---\nbody`;
const withoutImage = (title) => `---\ntitle: "${title}"\ndate: "2026-08-30"\n---\nbody`;

let repoFiles;
let fileContents; // path -> raw string
let githubCalls;
let existingPrsForBranch;
let imageSearchResult; // what the mocked searchImage returns, or a function(query)=>result
let pexelsIsConfigured;
let currentSite;

mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => currentSite } });

mock.module(resolve('../github/client.js'), {
  namedExports: {
    getRepoTree: async () => ({ files: repoFiles, truncated: false }),
    getFileContent: async (_s, path) => (fileContents[path] ? { content: fileContents[path], sha: 'sha' } : null),
    getBranchSha: async () => 'base-sha',
    createBranch: async (...a) => { githubCalls.createBranch.push(a); },
    commitFilesAtomic: async (...a) => { githubCalls.commitFilesAtomic.push(a); },
    openPullRequest: async (...a) => { githubCalls.openPullRequest.push(a); return { url: 'https://github.com/acme/site/pull/9', number: 9 }; },
    listOpenPullRequestsForBranch: async () => existingPrsForBranch,
    defaultBranchName: () => 'main',
  },
});

mock.module(resolve('../generators/lib/pexels-client.js'), {
  namedExports: {
    configured: () => pexelsIsConfigured,
    buildImageQueries: ({ title }) => [title],
    searchImage: async (queries) => {
      const q = Array.isArray(queries) ? queries[0] : queries;
      if (typeof imageSearchResult === 'function') return imageSearchResult(q);
      return imageSearchResult;
    },
  },
});

const { backfillBlogImagesForSite } = await import(resolve('./backfill-blog-images.js'));

beforeEach(() => {
  repoFiles = [];
  fileContents = {};
  githubCalls = { createBranch: [], commitFilesAtomic: [], openPullRequest: [] };
  existingPrsForBranch = [];
  imageSearchResult = { url: 'https://images.pexels.com/photos/1/x.jpeg', alt: 'A relevant photo', photographer: 'Someone' };
  pexelsIsConfigured = true;
  currentSite = SITE;
});

describe('backfillBlogImagesForSite', () => {
  test('adds an image only to posts with none, and opens one PR for all of them', async () => {
    repoFiles = ['src/blog/has-image.md', 'src/blog/no-image-1.md', 'src/blog/no-image-2.md', 'src/blog/blog.json', 'src/blog/index.njk'];
    fileContents = {
      'src/blog/has-image.md': withImage('Already Has One'),
      'src/blog/no-image-1.md': withoutImage('Understanding Dental AI Secretaries'),
      'src/blog/no-image-2.md': withoutImage('What Is Agentic Commerce'),
    };

    const report = await backfillBlogImagesForSite(1);

    assert.equal(report.checked, 2, 'only the two posts with no image field are checked');
    assert.equal(report.imaged, 2);
    assert.equal(githubCalls.commitFilesAtomic.length, 1, 'one commit, not one PR per post');
    const [, , files] = githubCalls.commitFilesAtomic[0];
    assert.equal(files.length, 2);
    assert.ok(!files.some((f) => f.path === 'src/blog/has-image.md'), 'the already-imaged post is never touched');
    assert.ok(report.prCreated.url);
  });

  test('never rewrites a post that already has an image, under any alias', async () => {
    repoFiles = ['src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md'];
    fileContents = {
      'src/blog/a.md': '---\ntitle: "A"\nfeaturedImage: "/x.jpg"\n---\nbody',
      'src/blog/b.md': '---\ntitle: "B"\nimage: "/x.jpg"\n---\nbody',
      'src/blog/c.md': '---\ntitle: "C"\nheroImage: "/x.jpg"\n---\nbody',
    };
    const report = await backfillBlogImagesForSite(1);
    assert.equal(report.checked, 0);
    assert.equal(githubCalls.commitFilesAtomic.length, 0);
  });

  test('a post with no good relevance match gets no image, and is not silently forced into one', async () => {
    repoFiles = ['src/blog/no-match.md'];
    fileContents = { 'src/blog/no-match.md': withoutImage('A Very Obscure Topic') };
    imageSearchResult = null; // searchImage's own relevance floor rejected everything
    const report = await backfillBlogImagesForSite(1);
    assert.equal(report.noMatch, 1);
    assert.equal(report.imaged, 0);
    assert.equal(githubCalls.commitFilesAtomic.length, 0, 'nothing to commit when nothing was imaged');
  });

  test('never touches the body — only inserts front-matter fields', async () => {
    repoFiles = ['src/blog/x.md'];
    fileContents = { 'src/blog/x.md': withoutImage('X') };
    await backfillBlogImagesForSite(1);
    const [, , files] = githubCalls.commitFilesAtomic[0];
    assert.match(files[0].content, /^---\n[\s\S]*body$/);
    assert.ok(files[0].content.endsWith('body'), 'body text preserved verbatim');
    assert.match(files[0].content, /featuredImage: "https:\/\/images\.pexels\.com\/photos\/1\/x\.jpeg"/);
    assert.match(files[0].content, /featuredImageAlt: "A relevant photo"/);
    assert.match(files[0].content, /featuredImageCredit: "Photo by Someone on Pexels"/);
  });

  test('reuses an already-open PR on the same day\'s branch instead of opening a second one', async () => {
    repoFiles = ['src/blog/x.md'];
    fileContents = { 'src/blog/x.md': withoutImage('X') };
    existingPrsForBranch = [{ html_url: 'https://github.com/acme/site/pull/5', number: 5 }];
    const report = await backfillBlogImagesForSite(1);
    assert.equal(githubCalls.openPullRequest.length, 0);
    assert.equal(report.prCreated.number, 5);
    assert.equal(report.prCreated.reused, true);
  });

  test('skips directory data files, the directory index, and files with the wrong extension', async () => {
    repoFiles = ['src/blog/blog.json', 'src/blog/index.njk', 'src/blog/2024/nested.md', 'src/blog/real.md'];
    fileContents = { 'src/blog/real.md': withoutImage('Real Post') };
    const report = await backfillBlogImagesForSite(1);
    assert.equal(report.checked, 1);
  });

  test('a site with no repo connected is a no-op, not an error', async () => {
    repoFiles = ['src/blog/x.md'];
    fileContents = { 'src/blog/x.md': withoutImage('X') };
    currentSite = { id: 2 }; // no repo_owner/repo_name
    const report = await backfillBlogImagesForSite(2);
    assert.equal(report.checked, 0);
    assert.equal(githubCalls.commitFilesAtomic.length, 0);
  });

  test('disabled image feature flag short-circuits before touching the repo', async () => {
    pexelsIsConfigured = false;
    repoFiles = ['src/blog/x.md'];
    const report = await backfillBlogImagesForSite(1);
    assert.equal(report.checked, 0);
  });

  test('dry run finds work but commits nothing', async () => {
    repoFiles = ['src/blog/x.md'];
    fileContents = { 'src/blog/x.md': withoutImage('X') };
    const report = await backfillBlogImagesForSite(1, { dryRun: true });
    assert.equal(report.imaged, 1);
    assert.equal(githubCalls.commitFilesAtomic.length, 0);
    assert.equal(report.prCreated, null);
  });
});
