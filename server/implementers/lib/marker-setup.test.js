import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Body-marker detection learns and stores a strategy per template (strategy-registry.js, a database table). Replaced here by a small
// deterministic detector: the marker goes just before </main>, and a file with no <main> has no safe place.
mock.module('./strategy-registry.js', {
  namedExports: {
    getOrDetectStrategy: async (_site, _path, content) => {
      const at = content.indexOf('</main>');
      return at < 0
        ? { ok: false, reason: 'no-insertion-point', error: 'no <main> found' }
        : { ok: true, insertBeforeOffset: at, containerDescription: 'main', source: 'test' };
    },
  },
});
const { runMarkerSetup, planMarkerSetup, collectTargets, markerSetupEnabled, setupBranchName } = await import('./marker-setup.js');

const TYPES = ['meta-title', 'faq'];
const page = '<html><head><title>x</title></head><body><main><h1>Hi</h1></main></body></html>';
const withMarkers = '<!-- SEOAI:TITLE:START --><!-- SEOAI:TITLE:END --><!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->';

const site = (extra = {}) => ({
  id: 7, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', website_domain: 'zennly.io', timezone: 'UTC',
  scope_exclude_paths: ['/business'],
  url_file_map: {
    markerSetup: { enabled: true },
    pages: { '/': { file: 'src/index.html', markers: { title: 'TITLE', faq: 'FAQ' } }, '/business/pricing': { file: 'src/business/pricing.html', markers: { title: 'TITLE', faq: 'FAQ' } } },
    ...extra,
  },
});

const fakes = (files = { 'src/index.html': page, 'src/business/pricing.html': page }, over = {}) => {
  const calls = { branches: [], commits: [], prs: [] };
  return {
    calls,
    deps: {
      pages: ['https://zennly.io/', 'https://zennly.io/business/pricing'],
      markerTypes: TYPES,
      getFile: async (_s, p) => (files[p] == null ? null : { content: files[p] }),
      getBranchSha: async (_s, b) => { if (b === setupBranchName(site())) throw new Error('404 Not Found'); return 'sha-main'; },
      createBranch: async (_s, b, sha) => calls.branches.push([b, sha]),
      commitFiles: async (_s, b, f, m) => calls.commits.push({ b, paths: f.map((x) => x.path), m, f }),
      openPr: async (_s, o) => { calls.prs.push(o); return { number: 5, url: 'https://github.com/o/r/pull/5' }; },
      findOpenPr: async () => null,
      open: true,
      ...over,
    },
  };
};

describe('marker setup', () => {
  test('off unless the site opts in, and needs a repo', async () => {
    assert.equal(markerSetupEnabled({}), false);
    assert.deepEqual(await runMarkerSetup(site({ markerSetup: { enabled: false } }), fakes().deps), { status: 'disabled' });
    assert.deepEqual(await runMarkerSetup({ ...site(), repo_owner: null }, fakes().deps), { status: 'no-repo' });
  });

  test('only pages inside the site\'s scope are targeted', () => {
    const t = collectTargets(site(), ['https://zennly.io/', 'https://zennly.io/business/pricing'], TYPES);
    assert.deepEqual([...t.keys()], ['src/index.html']);
  });

  test('adds only the missing markers, opens one PR, and writes no content', async () => {
    const { deps, calls } = fakes();
    const r = await runMarkerSetup(site(), deps);
    assert.equal(r.status, 'pr-opened');
    assert.deepEqual(r.files, ['src/index.html']);
    assert.equal(calls.branches[0][0], 'action-center/markers-setup-7');
    assert.equal(calls.prs[0].title, 'Action Center: add agent markers');
    const written = calls.commits[0].f[0].content;
    assert.match(written, /SEOAI:FAQ:START/); // a body marker goes where detection found a real place
    assert.match(written, /<h1>Hi<\/h1>/); // the page's own content is untouched
    // The title marker needs a front-matter value this plain HTML page does not have: reported, never forced in.
    assert.doesNotMatch(written, /SEOAI:TITLE/);
    assert.ok(r.unresolved.some((u) => u.markerName === 'TITLE'));
  });

  test('a file that already has every marker needs nothing', async () => {
    const { deps, calls } = fakes({ 'src/index.html': page + withMarkers });
    const r = await runMarkerSetup(site(), deps);
    assert.equal(r.status, 'nothing-to-do');
    assert.equal(r.alreadyComplete, 1);
    assert.equal(calls.prs.length, 0);
  });

  test('dry run (the default) changes nothing on GitHub', async () => {
    const { deps, calls } = fakes(undefined, { open: false });
    const r = await runMarkerSetup(site(), deps);
    assert.equal(r.status, 'dry-run');
    assert.equal(calls.branches.length + calls.commits.length + calls.prs.length, 0);
  });

  test('idempotent: an open setup PR is reported, never duplicated', async () => {
    const { deps, calls } = fakes(undefined, { findOpenPr: async () => ({ number: 9, html_url: 'u' }) });
    const r = await runMarkerSetup(site(), deps);
    assert.equal(r.status, 'already-open');
    assert.equal(r.prNumber, 9);
    assert.equal(calls.prs.length, 0);
  });

  test('an existing setup branch with no PR is reported, not overwritten', async () => {
    const { deps, calls } = fakes(undefined, { getBranchSha: async () => 'sha' });
    const r = await runMarkerSetup(site(), deps);
    assert.equal(r.status, 'branch-exists');
    assert.equal(calls.branches.length, 0);
  });

  test('the write scope blocks a file the site does not own, before anything is written', async () => {
    const s = site({ writeScope: { allow: ['src/other/'] } });
    const { deps, calls } = fakes();
    const r = await runMarkerSetup(s, deps);
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'outside-write-scope');
    assert.equal(calls.branches.length, 0);
  });

  test('a marker with no safe place is reported as unresolved, never forced in', async () => {
    const { deps } = fakes({ 'src/index.html': 'just text, no markup' }, { open: false });
    const plan = await planMarkerSetup(site(), { pages: deps.pages, markerTypes: TYPES, getFile: deps.getFile, ref: 'main' });
    assert.equal(plan.files.length, 0);
    assert.ok(plan.unresolved.length > 0);
  });

  test('an unreadable or missing file is reported and does not stop the others', async () => {
    const { deps } = fakes({}, { open: false });
    const plan = await planMarkerSetup(site(), { pages: deps.pages, markerTypes: TYPES, getFile: deps.getFile, ref: 'main' });
    assert.equal(plan.unreadable.length, 1);
  });
});
