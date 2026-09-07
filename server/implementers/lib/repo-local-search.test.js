import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// searchRepoLocalForStrings uses only getRepoTree/getFileContent (Git Trees +
// Contents APIs) — the two GitHub calls that stay fully App-token-compatible,
// unlike /search/code (see the module's own header comment). Mocked wholesale
// so these tests exercise only this module's own filtering/bounding/matching
// logic, same convention as github-ops.test.js.
let treeImpl;
let fileImpl;
mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getRepoTree: (...a) => treeImpl(...a),
    getFileContent: (...a) => fileImpl(...a),
  },
});

const { searchRepoLocalForStrings, MAX_LOCAL_SEARCH_FILES } = await import('./repo-local-search.js');

const site = { id: 1, repo_owner: 'acme', repo_name: 'site' };

describe('searchRepoLocalForStrings — App-token repository inspection (Git Trees + Contents API only)', () => {
  test('fetches the tree once via getRepoTree, then fetches content only for real candidate files', async () => {
    const treeCalls = [];
    const fileCalls = [];
    treeImpl = async (s, ref) => { treeCalls.push({ s, ref }); return { files: ['src/pages/about.njk', 'package.json', 'node_modules/x/index.js'], truncated: false }; };
    fileImpl = async (s, path) => { fileCalls.push(path); return { content: 'no match here', sha: 'abc' }; };

    await searchRepoLocalForStrings(site, 'main', ['https://dead.example/']);

    assert.equal(treeCalls.length, 1);
    assert.equal(treeCalls[0].ref, 'main');
    // package.json has no content extension, node_modules/ is excluded —
    // only the real template file is ever fetched.
    assert.deepEqual(fileCalls, ['src/pages/about.njk']);
  });
});

describe('searchRepoLocalForStrings — local code search (literal match across template/markup files)', () => {
  test('finds a file that hardcodes any of the given literal variants', async () => {
    treeImpl = async () => ({ files: ['src/pages/a.njk', 'src/pages/b.njk'], truncated: false });
    fileImpl = async (s, path) => ({
      content: path === 'src/pages/b.njk' ? '<a href="/old-page">x</a>' : 'nothing relevant',
      sha: 'x',
    });

    const result = await searchRepoLocalForStrings(site, 'main', ['https://example.com/old-page', '/old-page']);
    assert.deepEqual(result.matches, ['src/pages/b.njk']);
    assert.equal(result.truncatedCoverage, false);
  });

  test('matches any of several literal variants (site-relative vs absolute), same as the code-search fallback it replaces', async () => {
    treeImpl = async () => ({ files: ['src/pages/a.njk'], truncated: false });
    fileImpl = async () => ({ content: '<a href="/relative-only">x</a>', sha: 'x' });

    const result = await searchRepoLocalForStrings(site, 'main', ['https://example.com/relative-only', '/relative-only']);
    assert.deepEqual(result.matches, ['src/pages/a.njk']);
  });
});

describe('searchRepoLocalForStrings — missing file/path', () => {
  test('a candidate file that 404s (getFileContent returns null) is skipped, not an error', async () => {
    treeImpl = async () => ({ files: ['src/pages/gone.njk'], truncated: false });
    fileImpl = async () => null;

    const result = await searchRepoLocalForStrings(site, 'main', ['/x']);
    assert.deepEqual(result.matches, []);
    assert.equal(result.scanned, 0);
  });
});

describe('searchRepoLocalForStrings — no match', () => {
  test('a fully-scanned repo with no hits reports truncatedCoverage: false — a confident negative, not a coverage gap', async () => {
    treeImpl = async () => ({ files: ['src/pages/a.njk', 'src/pages/b.md'], truncated: false });
    fileImpl = async () => ({ content: 'nothing relevant here', sha: 'x' });

    const result = await searchRepoLocalForStrings(site, 'main', ['/nowhere']);
    assert.deepEqual(result.matches, []);
    assert.equal(result.scanned, 2);
    assert.equal(result.truncatedCoverage, false, 'every real candidate was scanned — this is a genuine negative, not an incomplete search');
  });
});

describe('searchRepoLocalForStrings — multiple matches', () => {
  test('returns every distinct file that contains the literal, deduped', async () => {
    treeImpl = async () => ({ files: ['a.njk', 'b.njk', 'c.njk'], truncated: false });
    fileImpl = async (s, path) => ({ content: path === 'c.njk' ? 'no match' : '<a href="/shared-link">x</a>', sha: 'x' });

    const result = await searchRepoLocalForStrings(site, 'main', ['/shared-link']);
    assert.deepEqual(result.matches.sort(), ['a.njk', 'b.njk']);
  });
});

describe('searchRepoLocalForStrings — ambiguous match (bounded candidate set, priority ordering)', () => {
  test('when candidates exceed the file cap, priorityDirs are scanned first — a match outside priority dirs beyond the cap is genuinely not found, reported as a coverage gap, not a false negative', async () => {
    const files = [];
    for (let i = 0; i < MAX_LOCAL_SEARCH_FILES + 5; i++) files.push(`other/page-${i}.njk`);
    files.push('priority/target.njk'); // the real match, outside the first N in tree order
    treeImpl = async () => ({ files, truncated: false });
    fileImpl = async (s, path) => ({ content: path === 'priority/target.njk' ? '<a href="/the-link">x</a>' : 'irrelevant', sha: 'x' });

    // Without priority hint: the real match sorts after the cap and is missed.
    const withoutPriority = await searchRepoLocalForStrings(site, 'main', ['/the-link']);
    assert.deepEqual(withoutPriority.matches, []);
    assert.equal(withoutPriority.truncatedCoverage, true, 'coverage was genuinely incomplete — must not report this as a confirmed absence');

    // With the right priority hint: the real match is found within the bound.
    const withPriority = await searchRepoLocalForStrings(site, 'main', ['/the-link'], { priorityDirs: ['priority/'] });
    assert.deepEqual(withPriority.matches, ['priority/target.njk']);
    assert.equal(withPriority.truncatedCoverage, false);
  });
});

describe('searchRepoLocalForStrings — external GitHub search limitation (why this module exists at all)', () => {
  test('needs no code-search-specific credential — getRepoTree/getFileContent are the same Contents/Trees calls used everywhere else in this app, fully compatible with a GitHub App installation token', async () => {
    // Regression: /search/code silently returns empty results for a GitHub
    // App installation token on a private repo (a real, independently-
    // confirmed GitHub platform limitation — github.com/orgs/community/
    // discussions/113651), which is exactly why this module exists instead
    // of calling searchCodeForString. Proof here is structural: this
    // function never imports or calls searchCodeForString at all.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./repo-local-search.js', import.meta.url), 'utf8')
    );
    assert.doesNotMatch(source, /import\s*\{[^}]*searchCodeForString/, 'must never import /search/code\'s function at all, which does not work on the App-token path this module exists to replace');
  });
});
