import test from 'node:test';
import assert from 'node:assert/strict';
import { planSetupPr, openSetupPr, onlyMarkersAdded, setupBranchName, setupPrBody, MAX_FILES } from './setup-pr.js';

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
  assert.match(setupPrBody(big, plan), /capped at 60 files/);
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
