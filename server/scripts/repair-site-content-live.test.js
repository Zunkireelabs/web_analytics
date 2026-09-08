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
let queueRows; // in-memory fake of shipping_queue, keyed by id

mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => currentSite } });

// Mocked at the LOWEST level (github/client.js) only — the repair still
// fetches the real repo tree/file content to compute its diff. It no longer
// creates a branch, commits, or opens a PR itself (see the module's own
// comment: that step moved to the shared shipping queue), so this file no
// longer needs to fake createBranch/commitFilesAtomic/openPullRequest — but
// every real export is still spread in first, same as before, because
// implementers/lib/github-ops.js (still imported here for baseBranch()) and
// its own transitive imports (rendering-gate.js's getCheckRunsForRef, etc.)
// need something real to resolve against.
const realClient = await import(resolve('../github/client.js'));
mock.module(resolve('../github/client.js'), {
  namedExports: {
    ...realClient,
    getRepoTree: async () => ({ files: repoFiles, truncated: false }),
    getFileContent: async (_s, p) => (fileContents[p] !== undefined ? { content: fileContents[p], sha: 's' } : null),
  },
});

// Fakes store/shipping-queue.js's enqueue/markPrepared exactly as this
// module calls them — proving the repair now QUEUES its already-computed,
// already-validated edits instead of pushing a branch/PR directly.
let nextId = 1;
mock.module(resolve('../store/shipping-queue.js'), {
  namedExports: {
    enqueue: async (siteId, opts) => {
      const row = { id: nextId++, site_id: siteId, state: 'queued', ...opts };
      queueRows.push(row);
      return { row, created: true };
    },
    markPrepared: async (id, { filePaths, score }) => {
      const row = queueRows.find((r) => r.id === id);
      if (!row) return null;
      row.state = 'prepared';
      row.file_paths = filePaths;
      row.score = score;
      return row;
    },
  },
});

const { repairSiteContentLive } = await import(resolve('./repair-site-content-live.js'));

beforeEach(() => {
  currentSite = SITE;
  repoFiles = [];
  fileContents = {};
  queueRows = [];
  nextId = 1;
});

describe('repairSiteContentLive', () => {
  test('the real incident: a QACONTENT region using the old unstyled shape is queued for the shared shipping run, not committed directly', async () => {
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

    assert.deepEqual(report.changedFiles, ['src/pages/team.njk']);
    assert.equal(report.prCreated, null, 'this function must never open its own PR anymore');
    assert.ok(report.queued, 'the computed edit is queued for the shared shipping run');
    assert.equal(report.queued.state, 'prepared', 'already computed and validated — ready to ship, no further generation needed');

    assert.equal(queueRows.length, 1);
    const row = queueRows[0];
    assert.equal(row.source, 'content-repair');
    assert.equal(row.kind, 'file-edits');
    assert.equal(row.params.edits.length, 1);
    assert.match(row.params.edits[0].content, /expandAll/, 'restyled through the site\'s real accordion, not left as qa-content');
    assert.match(row.params.commitMessage, /Repair shipped content/);
  });

  test('the blog-index self-inclusion bug is fixed as part of the same computed diff', async () => {
    repoFiles = ['src/blog/blog.json', 'src/blog/index.njk'];
    fileContents = {
      'src/blog/blog.json': '{ "layout": "blog-post.njk", "tags": ["blog"] }',
      'src/blog/index.njk': '---\nlayout: base.njk\ntitle: "AI Blog"\npermalink: /blog/\n---\n<h1>Blog</h1>',
    };
    await repairSiteContentLive(1);
    const indexEdit = queueRows[0].params.edits.find((f) => f.path === 'src/blog/index.njk');
    assert.ok(indexEdit);
    assert.match(indexEdit.content, /eleventyExcludeFromCollections: true/);
  });

  test('nothing to fix queues nothing', async () => {
    repoFiles = ['src/pages/about.njk'];
    fileContents = { 'src/pages/about.njk': '---\ntitle: "About"\n---\n<p>Clean content, nothing to repair.</p>' };
    const report = await repairSiteContentLive(1);
    assert.equal(queueRows.length, 0);
    assert.equal(report.prCreated, null);
    assert.equal(report.queued, undefined);
    assert.deepEqual(report.changedFiles, []);
  });

  test('a site with no repo connected is a no-op', async () => {
    currentSite = { id: 2 };
    const report = await repairSiteContentLive(2);
    assert.equal(report.skipped, 'no-repo');
    assert.equal(queueRows.length, 0);
  });

  test('a site with no stored component templates is a no-op, not a crash', async () => {
    currentSite = { id: 3, repo_owner: 'a', repo_name: 'b', url_file_map: {} };
    const report = await repairSiteContentLive(3);
    assert.equal(report.skipped, 'no-component-templates');
  });

  test('dry run finds work but queues nothing', async () => {
    repoFiles = ['src/blog/blog.json', 'src/blog/index.njk'];
    fileContents = {
      'src/blog/blog.json': '{ "tags": ["blog"] }',
      'src/blog/index.njk': '---\nlayout: base.njk\npermalink: /blog/\n---\nbody',
    };
    const report = await repairSiteContentLive(1, { dryRun: true });
    assert.ok(report.changedFiles.length > 0);
    assert.equal(queueRows.length, 0);
    assert.equal(report.prCreated, null);
  });

  test('only files that actually changed are queued, not everything fetched', async () => {
    repoFiles = ['src/pages/clean.njk', 'src/blog/blog.json', 'src/blog/index.njk'];
    fileContents = {
      'src/pages/clean.njk': '---\ntitle: "Clean"\n---\n<p>Nothing wrong here.</p>',
      'src/blog/blog.json': '{ "tags": ["blog"] }',
      'src/blog/index.njk': '---\nlayout: base.njk\npermalink: /blog/\n---\nbody',
    };
    await repairSiteContentLive(1);
    assert.equal(queueRows[0].params.edits.length, 1);
    assert.equal(queueRows[0].params.edits[0].path, 'src/blog/index.njk');
  });
});
