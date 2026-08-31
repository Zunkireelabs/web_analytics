import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

const FAQ_TEMPLATE = {
  wrapper: '<section class="py-12 md:py-20 bg-gray-50">\n  <div x-data="{ activeIndex: null, expandAll: false }">\n{{ROWS}}\n  </div>\n</section>',
  row: '<div class="py-5"><button @click="activeIndex = {{INDEX}}">{{QUESTION}}</button><div x-show="activeIndex === {{INDEX}}"><p class="pt-4">{{ANSWER}}</p></div></div>',
};

const SITE = {
  id: 1, name: 'Zunkiree Labs', repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web',
  visible_faq_cap: 5,
  url_file_map: {
    newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } },
    siteRoot: { componentTemplates: { faq: FAQ_TEMPLATE, qaContent: FAQ_TEMPLATE } },
  },
};

let currentSite;
let repoFiles;
let fileContents;
let githubCalls;
let existingPrsForBranch;

mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => currentSite } });
mock.module(resolve('../github/client.js'), {
  namedExports: {
    getRepoTree: async () => ({ files: repoFiles, truncated: false }),
    getFileContent: async (_s, p) => (fileContents[p] !== undefined ? { content: fileContents[p], sha: 's' } : null),
    getBranchSha: async () => 'base-sha',
    createBranch: async (...a) => { githubCalls.createBranch.push(a); },
    commitFilesAtomic: async (...a) => { githubCalls.commitFilesAtomic.push(a); },
    openPullRequest: async (...a) => { githubCalls.openPullRequest.push(a); return { url: 'https://github.com/acme/x/pull/1', number: 1 }; },
    listOpenPullRequestsForBranch: async () => existingPrsForBranch,
    defaultBranchName: () => 'main',
  },
});

const { repairSiteContentLive } = await import(resolve('./repair-site-content-live.js'));

beforeEach(() => {
  currentSite = SITE;
  repoFiles = [];
  fileContents = {};
  githubCalls = { createBranch: [], commitFilesAtomic: [], openPullRequest: [] };
  existingPrsForBranch = [];
});

describe('repairSiteContentLive', () => {
  test('the real incident: a QACONTENT region using the old unstyled shape gets restyled and committed', async () => {
    repoFiles = ['src/pages/team.njk'];
    fileContents = {
      'src/pages/team.njk': [
        '---\ntitle: "Team"\n---',
        '<!-- SEOAI:QACONTENT:START --><div class="qa-content">',
        '  <details><summary><h3>What do you build?</h3></summary><p>AI infrastructure.</p></details>',
        '</div><!-- SEOAI:QACONTENT:END -->',
      ].join('\n'),
    };

    const report = await repairSiteContentLive(1);

    assert.equal(githubCalls.commitFilesAtomic.length, 1);
    const [, , files] = githubCalls.commitFilesAtomic[0];
    assert.equal(files.length, 1);
    assert.match(files[0].content, /expandAll/, 'restyled through the site\'s real accordion, not left as qa-content');
    assert.ok(report.prCreated.url);
    assert.deepEqual(report.changedFiles, ['src/pages/team.njk']);
  });

  test('the blog-index self-inclusion bug is fixed as part of the same run', async () => {
    repoFiles = ['src/blog/blog.json', 'src/blog/index.njk'];
    fileContents = {
      'src/blog/blog.json': '{ "layout": "blog-post.njk", "tags": ["blog"] }',
      'src/blog/index.njk': '---\nlayout: base.njk\ntitle: "AI Blog"\npermalink: /blog/\n---\n<h1>Blog</h1>',
    };
    await repairSiteContentLive(1);
    const [, , files] = githubCalls.commitFilesAtomic[0];
    const indexFile = files.find((f) => f.path === 'src/blog/index.njk');
    assert.ok(indexFile);
    assert.match(indexFile.content, /eleventyExcludeFromCollections: true/);
  });

  test('nothing to fix commits nothing and opens no PR', async () => {
    repoFiles = ['src/pages/about.njk'];
    fileContents = { 'src/pages/about.njk': '---\ntitle: "About"\n---\n<p>Clean content, nothing to repair.</p>' };
    const report = await repairSiteContentLive(1);
    assert.equal(githubCalls.commitFilesAtomic.length, 0);
    assert.equal(githubCalls.openPullRequest.length, 0);
    assert.equal(report.prCreated, null);
    assert.deepEqual(report.changedFiles, []);
  });

  test('a site with no repo connected is a no-op', async () => {
    currentSite = { id: 2 };
    const report = await repairSiteContentLive(2);
    assert.equal(report.skipped, 'no-repo');
    assert.equal(githubCalls.commitFilesAtomic.length, 0);
  });

  test('a site with no stored component templates is a no-op, not a crash', async () => {
    currentSite = { id: 3, repo_owner: 'a', repo_name: 'b', url_file_map: {} };
    const report = await repairSiteContentLive(3);
    assert.equal(report.skipped, 'no-component-templates');
  });

  test('dry run finds work but writes nothing', async () => {
    repoFiles = ['src/blog/blog.json', 'src/blog/index.njk'];
    fileContents = {
      'src/blog/blog.json': '{ "tags": ["blog"] }',
      'src/blog/index.njk': '---\nlayout: base.njk\npermalink: /blog/\n---\nbody',
    };
    const report = await repairSiteContentLive(1, { dryRun: true });
    assert.ok(report.changedFiles.length > 0);
    assert.equal(githubCalls.commitFilesAtomic.length, 0);
    assert.equal(report.prCreated, null);
  });

  test('reuses an already-open PR on the same day\'s branch', async () => {
    repoFiles = ['src/blog/blog.json', 'src/blog/index.njk'];
    fileContents = {
      'src/blog/blog.json': '{ "tags": ["blog"] }',
      'src/blog/index.njk': '---\nlayout: base.njk\npermalink: /blog/\n---\nbody',
    };
    existingPrsForBranch = [{ html_url: 'https://github.com/acme/x/pull/7', number: 7 }];
    const report = await repairSiteContentLive(1);
    assert.equal(githubCalls.openPullRequest.length, 0);
    assert.equal(report.prCreated.number, 7);
    assert.equal(report.prCreated.reused, true);
  });

  test('only files that actually changed are committed, not everything fetched', async () => {
    repoFiles = ['src/pages/clean.njk', 'src/blog/blog.json', 'src/blog/index.njk'];
    fileContents = {
      'src/pages/clean.njk': '---\ntitle: "Clean"\n---\n<p>Nothing wrong here.</p>',
      'src/blog/blog.json': '{ "tags": ["blog"] }',
      'src/blog/index.njk': '---\nlayout: base.njk\npermalink: /blog/\n---\nbody',
    };
    await repairSiteContentLive(1);
    const [, , files] = githubCalls.commitFilesAtomic[0];
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'src/blog/index.njk');
  });
});
