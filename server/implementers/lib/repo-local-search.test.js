import { test, describe, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const resolve = (p) => new URL(p, import.meta.url).href;

// searchRepoLocalForStrings reads the repo as ONE tarball (getRepoTarball —
// REST-only and fully App-token-compatible, unlike /search/code) plus one
// cheap tree call used solely to detect GitHub's own truncation. Both are
// mocked, but the tarball is a REAL gzipped tar built from fixture files, so
// these tests exercise the actual download-extract-walk path rather than a
// stubbed idea of it.
let treeImpl;
let tarballCalls;
let repoFiles = {};

// Builds a genuine GitHub-shaped tarball: every entry nested under one
// generated top-level directory, which is what --strip-components=1 removes.
async function buildTarball(files) {
  const stage = await mkdtemp(join(tmpdir(), 'repo-local-search-fixture-'));
  const root = join(stage, 'acme-site-abc1234');
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    const tarPath = join(stage, 'out.tar.gz');
    await execFileAsync('tar', ['-czf', tarPath, '-C', stage, 'acme-site-abc1234']);
    return await readFile(tarPath);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getRepoTree: (...a) => treeImpl(...a),
    getRepoTarball: async (s, ref) => { tarballCalls.push({ ref }); return buildTarball(repoFiles); },
  },
});

const { searchRepoLocalForStrings, MAX_LOCAL_SEARCH_FILES, clearRepoLocalSearchCache } = await import('./repo-local-search.js');

const site = { id: 1, repo_owner: 'acme', repo_name: 'site' };

beforeEach(async () => {
  tarballCalls = [];
  repoFiles = {};
  treeImpl = async () => ({ files: [], truncated: false });
  await clearRepoLocalSearchCache();
});

after(() => clearRepoLocalSearchCache());

describe('searchRepoLocalForStrings — repository inspection cost', () => {
  // The regression that matters most. The previous implementation issued one
  // Contents API call PER candidate file (up to MAX_LOCAL_SEARCH_FILES), and
  // a morning's batch of those exhausted site 1's whole hourly budget on
  // 2026-09-08 — the failure landing on the batch's final call, the shared
  // PR, stranding 21 pushed drafts with no pull request.
  test('reads the whole repo in ONE request, however many candidate files there are', async () => {
    repoFiles = {};
    for (let i = 0; i < 40; i++) repoFiles[`src/pages/page-${i}.njk`] = 'nothing relevant';
    await searchRepoLocalForStrings(site, 'main', ['https://dead.example/']);
    assert.equal(tarballCalls.length, 1, 'one tarball, not one request per file');
    assert.equal(tarballCalls[0].ref, 'main');
  });

  // One request per RUN, not per link: a batch checks many links against the
  // same ref, which is where the saving actually compounds.
  test('reuses one checkout across every search on the same ref', async () => {
    repoFiles = { 'src/pages/a.njk': 'nothing' };
    await searchRepoLocalForStrings(site, 'main', ['/one']);
    await searchRepoLocalForStrings(site, 'main', ['/two']);
    await searchRepoLocalForStrings(site, 'main', ['/three']);
    assert.equal(tarballCalls.length, 1);
  });

  test('concurrent searches on one ref share a single in-flight download', async () => {
    repoFiles = { 'src/pages/a.njk': 'nothing' };
    await Promise.all([
      searchRepoLocalForStrings(site, 'main', ['/a']),
      searchRepoLocalForStrings(site, 'main', ['/b']),
      searchRepoLocalForStrings(site, 'main', ['/c']),
    ]);
    assert.equal(tarballCalls.length, 1, 'a race must not turn one download into three');
  });

  test('a different ref is a different checkout', async () => {
    repoFiles = { 'src/pages/a.njk': 'nothing' };
    await searchRepoLocalForStrings(site, 'main', ['/x']);
    await searchRepoLocalForStrings(site, 'other-branch', ['/x']);
    assert.equal(tarballCalls.length, 2);
  });
});

describe('searchRepoLocalForStrings — what gets scanned', () => {
  test('scans only real template/markup files, skipping vendor dirs and non-content extensions', async () => {
    repoFiles = {
      'src/pages/about.njk': 'nothing relevant',
      'package.json': '{}',
      'node_modules/x/index.js': 'irrelevant',
      'dist/bundle.js': 'irrelevant',
    };
    const result = await searchRepoLocalForStrings(site, 'main', ['https://dead.example/']);
    assert.equal(result.scanned, 1, 'only the .njk template is a real candidate');
  });

  // Reachable only now that coverage is complete: a docs/config file under a
  // dot-directory quotes URLs, and broken-link-fix EDITS what it is handed.
  test('never offers a file under a dot-directory as a candidate', async () => {
    repoFiles = {
      '.claude/skills/schema-generator/SKILL.md': 'see https://dead.example/gone',
      '.github/workflows/notes.md': 'see https://dead.example/gone',
      'src/pages/real.njk': '<a href="https://dead.example/gone">x</a>',
    };
    const result = await searchRepoLocalForStrings(site, 'main', ['https://dead.example/gone']);
    assert.deepEqual(result.matches, ['src/pages/real.njk'], 'only real rendered content is editable candidate material');
  });

  // Eleventy-style _data/*.js files render straight into pages without ever
  // containing markup — excluding .js entirely made a link that plainly
  // exists in the repo (e.g. zunkireelabs-web's src/_data/authors.js) come
  // back as "not found in any file".
  test('treats a non-vendor .js data file as a real candidate', async () => {
    repoFiles = {
      'src/_data/authors.js': 'export default { social: { twitter: "https://twitter.com/zunkiree" } };',
    };
    const result = await searchRepoLocalForStrings(site, 'main', ['https://twitter.com/zunkiree']);
    assert.deepEqual(result.matches, ['src/_data/authors.js']);
  });

  test('finds a file that hardcodes any of the given literal variants', async () => {
    repoFiles = { 'src/pages/a.njk': 'nothing relevant', 'src/pages/b.njk': '<a href="/old-page">x</a>' };
    const result = await searchRepoLocalForStrings(site, 'main', ['https://example.com/old-page', '/old-page']);
    assert.deepEqual(result.matches, ['src/pages/b.njk']);
    assert.equal(result.truncatedCoverage, false);
  });

  test('returns every distinct file containing the literal, deduped', async () => {
    repoFiles = { 'a.njk': '<a href="/shared-link">x</a>', 'b.njk': '<a href="/shared-link">y</a>', 'c.njk': 'no match' };
    const result = await searchRepoLocalForStrings(site, 'main', ['/shared-link']);
    assert.deepEqual(result.matches.sort(), ['a.njk', 'b.njk']);
  });
});

describe('searchRepoLocalForStrings — coverage claims', () => {
  // The reason the tarball switch matters for CORRECTNESS, not just spend:
  // a negative from a complete scan is a real answer, and the old bounded
  // scan could not give one on a repo larger than the cap.
  test('a fully-scanned repo with no hits is a confident negative', async () => {
    repoFiles = { 'src/pages/a.njk': 'nothing relevant', 'src/pages/b.md': 'also nothing' };
    const result = await searchRepoLocalForStrings(site, 'main', ['/nowhere']);
    assert.deepEqual(result.matches, []);
    assert.equal(result.scanned, 2);
    assert.equal(result.truncatedCoverage, false, 'every real candidate was scanned — a genuine absence');
  });

  // Previously this needed a priorityDirs hint to be found at all, because
  // the file beyond the cap was never fetched. Now the cap only bounds
  // memory, and a repo of this size is scanned completely.
  test('finds a match anywhere in the repo without needing a priority hint', async () => {
    repoFiles = {};
    for (let i = 0; i < 60; i++) repoFiles[`other/page-${i}.njk`] = 'irrelevant';
    repoFiles['deep/nested/target.njk'] = '<a href="/the-link">x</a>';
    const result = await searchRepoLocalForStrings(site, 'main', ['/the-link']);
    assert.deepEqual(result.matches, ['deep/nested/target.njk']);
    assert.equal(result.truncatedCoverage, false);
  });

  test("GitHub's own tree truncation is still reported as a coverage gap, never as a confirmed absence", async () => {
    repoFiles = { 'src/pages/a.njk': 'nothing relevant' };
    treeImpl = async () => ({ files: [], truncated: true });
    const result = await searchRepoLocalForStrings(site, 'main', ['/nowhere']);
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncatedCoverage, true);
  });

  test('a found match is never reported as a coverage gap, even on a truncated tree', async () => {
    repoFiles = { 'src/pages/a.njk': '<a href="/found">x</a>' };
    treeImpl = async () => ({ files: [], truncated: true });
    const result = await searchRepoLocalForStrings(site, 'main', ['/found']);
    assert.deepEqual(result.matches, ['src/pages/a.njk']);
    assert.equal(result.truncatedCoverage, false);
  });

  // The tree call is now diagnostic only. A search that already succeeded
  // must not be failed by it.
  test('a failing tree call does not fail a search that already read the repo', async () => {
    repoFiles = { 'src/pages/a.njk': '<a href="/found">x</a>' };
    treeImpl = async () => { throw new Error('502 from the trees API'); };
    const result = await searchRepoLocalForStrings(site, 'main', ['/found']);
    assert.deepEqual(result.matches, ['src/pages/a.njk']);
  });
});

describe('searchRepoLocalForStrings — external GitHub search limitation (why this module exists at all)', () => {
  test('needs no code-search-specific credential — the tarball and tree calls are both App-token-compatible', async () => {
    // Regression: /search/code silently returns empty results for a GitHub
    // App installation token on a private repo (a real, independently-
    // confirmed GitHub platform limitation — github.com/orgs/community/
    // discussions/113651), which is exactly why this module exists instead
    // of calling searchCodeForString. Proof here is structural: this
    // function never imports or calls searchCodeForString at all.
    const source = await readFile(new URL('./repo-local-search.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /import\s*\{[^}]*searchCodeForString/, 'must never import /search/code\'s function at all, which does not work on the App-token path this module exists to replace');
  });

  test('the memory bound still exists and still bounds the scan', async () => {
    assert.ok(MAX_LOCAL_SEARCH_FILES > 0);
    repoFiles = {};
    for (let i = 0; i < MAX_LOCAL_SEARCH_FILES + 5; i++) repoFiles[`other/page-${i}.njk`] = 'irrelevant';
    const result = await searchRepoLocalForStrings(site, 'main', ['/nowhere']);
    assert.equal(result.scanned, MAX_LOCAL_SEARCH_FILES);
    assert.equal(result.truncatedCoverage, true, 'over the bound, a negative is still only a bounded negative');
  });
});
