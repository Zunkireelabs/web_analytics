import test from 'node:test';
import assert from 'node:assert/strict';
import { planSetupPr, openSetupPr, refreshSetupPr, onlyMarkersAdded, setupBranchName, setupPrBody, MAX_FILES } from './setup-pr.js';
import { sameLinesIgnoringOrder } from './head-tag-adopt.js';

// Real resolvers (url-file-map.js, insertion-engine.js, marker-merge.js); only the repository reads and the page list are faked.
// Head-scoped and front-matter markers need no structural detection, so these tests need no database.
const LAYOUT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>About us</title>
</head>
<body><main><h1>About</h1><p>Hello.</p></main></body>
</html>
`;
const POST = `---
title: "A blog post"
description: "About a thing"
layout: post.njk
---
# A blog post

Body text.
`;
const site = {
  id: 77, name: 'Acme', repo_default_branch: 'main', website_domain: 'example.com',
  url_file_map: { pages: { '/about': { file: 'src/pages/about.njk' }, '/blog/post': { file: 'src/blog/post.md' } } },
};
const files = { 'src/pages/about.njk': LAYOUT, 'src/blog/post.md': POST };
const deps = (over = {}) => ({
  listPages: async () => ['https://example.com/about', 'https://example.com/blog/post', 'https://example.com/unmapped'],
  markerTypes: async () => ['meta-title', 'canonical', 'open-graph'],
  readFile: async (s, path) => (path in files ? files[path] : null),
  ...over,
});

test('plans markers for mapped templates, ignores unmapped pages, and changes nothing but markers', async () => {
  const plan = await planSetupPr(site, deps());
  assert.equal(plan.pagesSeen, 3);
  assert.equal(plan.filesSeen, 2);
  assert.ok(plan.files.length >= 1);
  for (const f of plan.files) {
    assert.ok(f.added.length > 0);
    assert.equal(onlyMarkersAdded(f.before, f.content), true, `${f.path} changed more than markers`);
    assert.notEqual(f.content, f.before);
  }
  const head = plan.files.find((f) => f.path === 'src/pages/about.njk');
  assert.match(head.content, /SEOAI:HEAD/);
});

test('running it again on its own output plans nothing new', async () => {
  const first = await planSetupPr(site, deps());
  const done = Object.fromEntries(first.files.map((f) => [f.path, f.content]));
  const second = await planSetupPr(site, deps({ readFile: async (s, p) => (p in done ? done[p] : files[p] ?? null) }));
  assert.equal(second.files.length, 0);      // idempotent: running it again plans nothing new
});

test('missing or unreadable files are reported, never fatal', async () => {
  const plan = await planSetupPr(site, deps({ readFile: async (s, p) => { if (p.endsWith('.md')) throw new Error('boom'); return null; } }));
  assert.equal(plan.files.length, 0);
  assert.deepEqual(plan.skipped.map((s) => s.reason).sort(), ['could not be read', 'not found in the repository']);
});

test('a marker whose creation changes more than a comment is dropped, the file\'s other markers still go in (real engine, markdown page)', async () => {
  // Real behaviour found by running the engine: on a front-matter page a canonical marker is created as a NEW key `canonicalUrl: ""`.
  const plan = await planSetupPr(site, deps({ markerTypes: async () => ['canonical'] }));
  const post = plan.files.find((f) => f.path === 'src/blog/post.md');
  assert.equal(post, undefined);                                     // nothing safe to add to that file
  assert.ok(plan.skipped.some((s) => s.path === 'src/blog/post.md' && s.markerName === 'CANONICAL' && /not only a marker/.test(s.reason)));
});

test('an engine that edits real content is never used, even when it also adds the marker', async () => {
  const sneaky = async (s, p, c, map) => ({ content: c.replace('Hello.', 'Hacked.') + Object.values(map).map((n) => `<!-- SEOAI:${n}:START --><!-- SEOAI:${n}:END -->`).join(''), unresolved: [] });
  const plan = await planSetupPr(site, deps({ resolveInsertion: sneaky }));
  assert.equal(plan.files.length, 0);
  assert.ok(plan.skipped.some((s) => /not only a marker/.test(s.reason)));
});

test('onlyMarkersAdded: markers and the whitespace they sit on are ignored, any other edit is not', () => {
  assert.equal(onlyMarkersAdded('<p>a</p>', '<p>a</p>\n<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->\n'), true);
  assert.equal(onlyMarkersAdded('<p>a</p>', '<p>b</p>\n<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->'), false);
  assert.equal(onlyMarkersAdded('title: "x"', 'title: "x" # SEOAI:TITLE'), true);
  assert.equal(onlyMarkersAdded('<p>a</p>', '<p>a</p>{/* SEOAI:FAQ:START */}{/* SEOAI:FAQ:END */}'), true);
});

test('the PR is capped at MAX_FILES and says so', async () => {
  const many = Object.fromEntries(Array.from({ length: MAX_FILES + 5 }, (_, i) => [`/p${i}`, { file: `src/p${i}.njk` }]));
  const big = { ...site, url_file_map: { pages: many } };
  const plan = await planSetupPr(big, deps({
    listPages: async () => Object.keys(many).map((p) => `https://example.com${p}`),
    readFile: async () => LAYOUT,
  }));
  assert.equal(plan.files.length, MAX_FILES);
  assert.equal(plan.truncated, true);
  assert.match(setupPrBody(big, plan), new RegExp(`capped at ${MAX_FILES} files`));
});

test('dry run writes nothing; nothing-to-add opens nothing; a real run pushes one branch, one commit, one PR', async () => {
  const plan = await planSetupPr(site, deps());
  const calls = [];
  const gh = {
    listOpenPullRequestsForBranch: async () => { calls.push('list'); return []; },
    getDefaultBranchSha: async () => { calls.push('sha'); return 'abc'; },
    createBranch: async (s, b, sha) => { calls.push(`branch:${b}:${sha}`); return true; },
    commitFilesAtomic: async (s, b, fs, msg) => { calls.push(`commit:${fs.length}`); return { sha: 'c1' }; },
    openPullRequest: async (s, o) => { calls.push(`pr:${o.branch}`); return { number: 9, url: 'https://github.com/x/y/pull/9' }; },
  };
  const date = new Date('2026-11-19T12:00:00Z');
  const dry = await openSetupPr(site, plan, { dryRun: true, gh, date });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(calls, []);
  assert.equal((await openSetupPr(site, { files: [] }, { gh })).reason, 'nothing-to-add');

  const real = await openSetupPr(site, plan, { gh, date });
  assert.equal(real.opened, true);
  assert.equal(real.prNumber, 9);
  assert.equal(setupBranchName(site, date), 'seoai/setup-markers-77-2026-11-19');
  assert.deepEqual(calls, ['list', 'sha', 'branch:seoai/setup-markers-77-2026-11-19:abc', `commit:${plan.files.length}`, 'pr:seoai/setup-markers-77-2026-11-19']);
});

test('an already open setup PR is reused, not duplicated', async () => {
  const plan = await planSetupPr(site, deps());
  const gh = { listOpenPullRequestsForBranch: async () => [{ number: 4, html_url: 'https://github.com/x/y/pull/4' }] };
  const r = await openSetupPr(site, plan, { gh });
  assert.deepEqual([r.opened, r.reason, r.prNumber], [false, 'already-open', 4]);
});

test('coverage counts pages, not files: ready, partial, unmapped', async () => {
  const plan = await planSetupPr(site, deps());
  const c = plan.coverage;
  assert.equal(c.ready + c.partial + c.unmapped + c.unknown, plan.pagesSeen);
  assert.equal(c.unmapped, 1);                                   // /unmapped has no file
  assert.deepEqual(c.unmappedExamples, ['https://example.com/unmapped']);
  const body = setupPrBody(site, plan);
  assert.match(body, /Pages ready for the daily fixes once this is merged:\*\* \d+ of 3/);
  assert.match(body, /1 page with no template file known yet/);
});

test('a page whose template already holds every marker counts as ready without any change', async () => {
  const first = await planSetupPr(site, deps({ markerTypes: async () => ['canonical', 'open-graph'] }));
  const done = Object.fromEntries(first.files.map((f) => [f.path, f.content]));
  const again = await planSetupPr(site, deps({ markerTypes: async () => ['canonical', 'open-graph'], readFile: async (s, p) => (p in done ? done[p] : files[p] ?? null) }));
  assert.equal(again.files.length, 0);
  assert.ok(again.coverage.ready >= 1);
});

// ---- sitewide analytics markers: in the shared layout once, never asked of a page ----
const withLayout = { ...site, url_file_map: { ...site.url_file_map, siteRoot: { layoutTemplate: 'src/layouts/base.njk' } } };
const filesWithLayout = { ...files, 'src/layouts/base.njk': LAYOUT };

test('analytics markers are never asked of a page: a page file with no <head> is not left "partly ready" because of them', async () => {
  const plan = await planSetupPr(site, deps({ markerTypes: async () => ['analytics-install'] }));
  assert.equal(plan.unresolved.length, 0);
  assert.equal(plan.files.length, 0);
  assert.equal(plan.sitewide.layoutMissing, true);            // no layout mapped: said so, once
  assert.match(setupPrBody(site, plan), /Sitewide analytics markers were not added/);
});

test('with a shared layout mapped, the analytics markers go in the layout, once', async () => {
  const plan = await planSetupPr(withLayout, deps({ markerTypes: async () => ['analytics-install'], readFile: async (s, p) => (p in filesWithLayout ? filesWithLayout[p] : null) }));
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].path, 'src/layouts/base.njk');
  assert.match(plan.files[0].content, /SEOAI:ANALYTICSSCRIPTGA4/);
  assert.equal(onlyMarkersAdded(plan.files[0].before, plan.files[0].content), true);
  assert.deepEqual(plan.sitewide.layout, 'src/layouts/base.njk');
  assert.match(setupPrBody(withLayout, plan), /analytics markers go in the shared layout/);
});

test('page coverage ignores the layout and the sitewide markers', async () => {
  const plan = await planSetupPr(withLayout, deps({ markerTypes: async () => ['analytics-install', 'canonical'], readFile: async (s, p) => (p in filesWithLayout ? filesWithLayout[p] : null) }));
  const c = plan.coverage;
  assert.equal(c.ready + c.partial + c.unmapped + c.unknown, plan.pagesSeen);
  assert.ok(c.ready >= 1);                                    // the .njk page holds its canonical marker and nothing sitewide is demanded of it
});

test('the "not added" list is grouped by marker and reason with examples, not one line per file', async () => {
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`/q${i}`, { file: `src/q${i}.md` }]));
  const bigSite = { ...site, url_file_map: { pages: many } };
  const plan = await planSetupPr(bigSite, deps({
    listPages: async () => Object.keys(many).map((p) => `https://example.com${p}`),
    markerTypes: async () => ['open-graph'],
    readFile: async () => POST,           // markdown with front matter and no <head>
  }));
  const body = setupPrBody(bigSite, plan);
  assert.match(body, /OPENGRAPH: no-head-region in 12 files \(e\.g\. `src\/q\d+\.md`/);
  assert.equal((body.match(/OPENGRAPH/g) || []).length, 1);   // one grouped line, not twelve
});

// ---- rebuilding an existing setup PR in place (no second PR) ----
const OWN = 'Setup: add SuperRank markers to 10 templates';       // the subject openSetupPr writes
const fakeGh = (over = {}) => {
  const calls = [];
  const gh = {
    listCommitSubjectsAheadOfBase: async () => [OWN],
    getDefaultBranchSha: async () => { calls.push('baseSha'); return 'base123'; },
    createCommitObject: async (site, parent, files, msg) => { calls.push(`commit:${parent}:${files.length}:${msg}`); return 'new456'; },
    updateRef: async (site, branch, sha, opts) => { calls.push(`ref:${branch}:${sha}:force=${opts?.force}`); },
    updatePullRequest: async (site, n, body) => { calls.push(`pr:${n}`); gh.lastBody = body; return { number: n }; },
    ...over,
  };
  return { gh, calls };
};
const readyPlan = async () => planSetupPr(site, deps());

test('refresh: the branch is reset to ONE commit on the default tip, the same PR is updated, and no PR is opened', async () => {
  const plan = await readyPlan();
  const { gh, calls } = fakeGh();
  const r = await refreshSetupPr(site, { branch: 'seoai/setup-markers-77-2026-11-19', prNumber: 7, gh, plan });
  assert.equal(r.refreshed, true);
  assert.deepEqual(calls.map((c) => c.split(':')[0]), ['baseSha', 'commit', 'ref', 'pr']);
  assert.match(calls[1], new RegExp(`^commit:base123:${plan.files.length}:Setup: add SuperRank markers`));
  assert.equal(calls[2], 'ref:seoai/setup-markers-77-2026-11-19:new456:force=true');
  assert.equal(calls[3], 'pr:7');
  assert.match(gh.lastBody.body, /one-time setup pull request/);
  assert.equal(gh.openPullRequest, undefined);                    // a second PR is never opened
});

test('refresh: anyone else\'s commit on the branch stops it, and nothing is written', async () => {
  const { gh, calls } = fakeGh({ listCommitSubjectsAheadOfBase: async () => [OWN, 'Fix the header spacing'] });
  const r = await refreshSetupPr(site, { branch: 'b', prNumber: 7, gh, plan: await readyPlan() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'branch-has-other-commits');
  assert.deepEqual(r.foreign, ['Fix the header spacing']);
  assert.deepEqual(calls, []);
});

test('refresh: dry run, a deleted branch, nothing to add and a missing PR number all write nothing', async () => {
  const dry = fakeGh();
  const d = await refreshSetupPr(site, { branch: 'b', prNumber: 7, gh: dry.gh, plan: await readyPlan(), dryRun: true });
  assert.equal(d.dryRun, true);
  assert.deepEqual(dry.calls, []);
  assert.equal((await refreshSetupPr(site, { branch: 'b', prNumber: 7, gh: fakeGh({ listCommitSubjectsAheadOfBase: async () => null }).gh, plan: await readyPlan() })).reason, 'branch-gone');
  assert.equal((await refreshSetupPr(site, { branch: 'b', prNumber: 7, gh: fakeGh().gh, plan: { files: [] } })).reason, 'nothing-to-add');
  assert.equal((await refreshSetupPr(site, { branch: null, prNumber: null, gh: fakeGh().gh })).reason, 'missing-branch-or-pr');
});


// ---- head tags in a per-page head include (MOBILISE): title/description on the page file, open-graph and canonical in the include ----
// REAL files: mobilise-website-11ty src/services/index.njk front matter and src/_includes/heads/services-index.njk (staging, 2026-11-19).
const MOB_PAGE = `---
{
  "layout": "layouts/base.njk",
  "permalink": "/services/index.html",
  "headInclude": "heads/services-index.njk",
  "title": "B2B Marketing Services & Creative Production | MOBILISE",
  "description": "B2B marketing services from MOBILISE: full-service marketing",
  "componentBase": "../"
}
---

    <main id="smooth-wrapper"><h1>Services</h1></main>
`;
const MOB_HEAD = `
    
    <script defer src="../analytics.js"></script>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ title | escape }}</title>
    <meta name="description"
        content="{{ description | escape }}">
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
    <meta name="theme-color" content="#0A919B">
    <link rel="canonical" href="https://mobilise.agency/services/">
    <meta property="og:type" content="website">
    <meta property="og:locale" content="en_GB">
    <meta property="og:site_name" content="MOBILISE Agency">
    <meta property="og:title" content="B2B Marketing Services &amp; Creative Production | MOBILISE">
    <meta property="og:description" content="B2B strategy, creative production, design and development, sales enablement, and full-service campaign execution for global brands.">
    <meta property="og:url" content="https://mobilise.agency/services/">
    <meta property="og:image" content="https://mobilise.agency/images/Thumbnail.jpg">
    <meta property="og:image:width" content="2350">
    <meta property="og:image:height" content="588">
    <meta property="og:image:alt" content="MOBILISE B2B marketing services">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="B2B Marketing Services | MOBILISE">
    <meta name="twitter:description" content="Strategy, creative production, sales enablement and campaign execution for global B2B brands.">
    <meta name="twitter:image" content="https://mobilise.agency/images/Thumbnail.jpg">
    <link rel="icon" type="image/png" href="../images/favicon.png">
    <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;700;800&amp;family=Manrope:wght@400;700;800&amp;display=swap"
`;
const mobSite = {
  id: 8874, name: 'MOBILISE', repo_default_branch: 'main', website_domain: 'mobilise.agency',
  url_file_map: { pages: { '/services': { file: 'src/services/index.njk', placements: {
    'open-graph': { file: 'src/_includes/heads/services-index.njk' },
    canonical: { file: 'src/_includes/heads/services-index.njk' },
  } } } },
};
const mobFiles = { 'src/services/index.njk': MOB_PAGE, 'src/_includes/heads/services-index.njk': MOB_HEAD };
const mobDeps = (over = {}) => ({ listPages: async () => ['https://mobilise.agency/services/'], markerTypes: async () => ['meta-title', 'open-graph', 'canonical'], readFile: async (s, p) => mobFiles[p] ?? null, ...over });

test('head include: each fix type is placed in ITS OWN file, the existing tags are adopted, and the page is fully ready', async () => {
  const plan = await planSetupPr(mobSite, mobDeps());
  const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f]));
  assert.deepEqual(byPath['src/services/index.njk'].added.sort(), ['METADESCRIPTION', 'TITLE']);
  assert.deepEqual(byPath['src/_includes/heads/services-index.njk'].added.sort(), ['CANONICAL', 'OPENGRAPH']);
  assert.equal(plan.unresolved.length, 0);
  assert.deepEqual([plan.coverage.ready, plan.coverage.partial, plan.coverage.unmapped], [1, 0, 0]);
});

test('head include: nothing is lost or duplicated, and every tag the generators do not write stays exactly where it was', async () => {
  const plan = await planSetupPr(mobSite, mobDeps());
  const head = plan.files.find((f) => f.path === 'src/_includes/heads/services-index.njk');
  assert.equal(sameLinesIgnoringOrder(head.before, head.content), true);
  for (const keep of ['og:type', 'og:url', 'og:image', 'og:image:alt', 'twitter:image']) assert.equal(head.content.split('\n').filter((l) => l.includes(`"${keep}"`)).length, 1, keep);
  assert.equal(onlyMarkersAdded(MOB_PAGE, plan.files.find((f) => f.path === 'src/services/index.njk').content), true);   // the page file: comments only
});

test('without the per-action file setting the same page behaves as before: open-graph and canonical are reported, not guessed', async () => {
  const plain = { ...mobSite, url_file_map: { pages: { '/services': { file: 'src/services/index.njk' } } } };
  const plan = await planSetupPr(plain, mobDeps());
  assert.deepEqual(plan.files.map((f) => f.path), ['src/services/index.njk']);                       // title and description only
  assert.ok(plan.unresolved.some((u) => u.markerName === 'OPENGRAPH'));
  assert.deepEqual([plan.coverage.ready, plan.coverage.partial], [0, 1]);
});

test('a head file with the tags more than once is left alone and said so, not half-moved', async () => {
  const dup = { ...mobFiles, 'src/_includes/heads/services-index.njk': MOB_HEAD + '<meta property="og:title" content="again">\n' };
  const plan = await planSetupPr(mobSite, mobDeps({ readFile: async (s, p) => dup[p] ?? null }));
  const head = plan.files.find((f) => f.path === 'src/_includes/heads/services-index.njk');
  assert.ok(!head || !head.added.includes('OPENGRAPH'));
  assert.ok(plan.unresolved.some((u) => u.markerName === 'OPENGRAPH'));
});
