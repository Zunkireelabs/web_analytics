import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let savedConfig = null;
let recordedRepairs = [];

const realDb = await import(resolve('../../db.js'));
mock.module(resolve('../../db.js'), {
  namedExports: {
    ...realDb,
    updateSiteRepoConfig: async ({ siteId, urlFileMap }) => {
      savedConfig = { siteId, urlFileMap };
      return { id: siteId, url_file_map: urlFileMap, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main' };
    },
  },
});

mock.module(resolve('../../store/capability-repairs.js'), {
  namedExports: {
    recordCapabilityRepair: async (siteId, attempt) => { recordedRepairs.push({ siteId, ...attempt }); },
    listCapabilityRepairs: async () => [],
  },
});

const { findContentDirectories, autoHealNewContentTarget } = await import('./discover-content-target.js');

const site = { id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main', url_file_map: {} };
const treeOf = (...files) => async () => ({ files, truncated: false });

// Every file "has real page front matter" by default — neutralizes the
// real-page-evidence narrowing step for tests that are about a DIFFERENT
// axis of autoHealNewContentTarget (file-count, naming hints) so those tests
// keep testing exactly one thing. Tests for the evidence step itself supply
// their own fetchFile.
const pageFetchFile = async () => ({ content: '---\nlayout: base.njk\n---\ncontent' });

beforeEach(() => { savedConfig = null; recordedRepairs = []; });

describe('findContentDirectories — the never-guess evidence bar', () => {
  test('a directory with 3+ files sharing an extension qualifies', () => {
    const files = ['src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md'];
    const r = findContentDirectories(files);
    assert.deepEqual(r, [{ dir: 'src/blog', extension: '.md', fileCount: 3 }]);
  });

  test('below the minimum file count, a directory does not qualify', () => {
    const files = ['src/blog/a.md', 'src/blog/b.md'];
    assert.deepEqual(findContentDirectories(files), []);
  });

  test('excludes underscore-prefixed directories regardless of file count', () => {
    const files = ['src/_includes/a.md', 'src/_includes/b.md', 'src/_includes/c.md'];
    assert.deepEqual(findContentDirectories(files), []);
  });

  test('multiple qualifying directories are all reported, never picked between here', () => {
    const files = [
      'src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md',
      'src/pages/x.njk', 'src/pages/y.njk', 'src/pages/z.njk',
    ];
    const r = findContentDirectories(files);
    assert.equal(r.length, 2);
    assert.deepEqual(new Set(r.map((q) => q.dir)), new Set(['src/blog', 'src/pages']));
  });

  test('picks the predominant extension within a mixed-extension directory', () => {
    const files = ['src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md', 'src/blog/layout.njk'];
    const r = findContentDirectories(files);
    assert.deepEqual(r, [{ dir: 'src/blog', extension: '.md', fileCount: 3 }]);
  });

  test('ignores non-template extensions entirely', () => {
    const files = ['src/blog/a.png', 'src/blog/b.png', 'src/blog/c.png'];
    assert.deepEqual(findContentDirectories(files), []);
  });
});

describe('autoHealNewContentTarget', () => {
  test('persists a target when exactly one directory qualifies', async () => {
    const healed = await autoHealNewContentTarget(site, 'blog-outline', {
      fetchTree: treeOf('src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md'),
    });
    assert.ok(healed);
    assert.deepEqual(savedConfig.urlFileMap.newContentTargets['blog-outline'], { dir: 'src/blog', extension: '.md' });
    assert.equal(recordedRepairs[0]?.outcome, 'repaired');
  });

  // The whole point: writing the wrong directory means every future
  // blog-outline draft for this site gets created in the wrong place.
  test('writes NOTHING when two directories qualify and neither matches the actionType hint', async () => {
    const healed = await autoHealNewContentTarget(site, 'blog-outline', {
      fetchTree: treeOf(
        'src/pages/a.md', 'src/pages/b.md', 'src/pages/c.md',
        'src/docs/x.md', 'src/docs/y.md', 'src/docs/z.md',
      ),
      fetchFile: pageFetchFile,
    });
    assert.equal(healed, null);
    assert.equal(savedConfig, null);
    assert.equal(recordedRepairs[0]?.outcome, 'ambiguous');
  });

  test('narrows to the actionType-named directory when multiple qualify', async () => {
    const healed = await autoHealNewContentTarget(site, 'blog-outline', {
      fetchTree: treeOf(
        'src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md',
        'src/docs/x.md', 'src/docs/y.md', 'src/docs/z.md',
      ),
      fetchFile: pageFetchFile,
    });
    assert.ok(healed);
    assert.deepEqual(savedConfig.urlFileMap.newContentTargets['blog-outline'], { dir: 'src/blog', extension: '.md' });
  });

  test('writes NOTHING when no directory qualifies at all', async () => {
    const healed = await autoHealNewContentTarget(site, 'blog-outline', {
      fetchTree: treeOf('src/blog/a.md', 'src/blog/b.md'),
    });
    assert.equal(healed, null);
    assert.equal(recordedRepairs[0]?.outcome, 'not-found');
  });

  test('does nothing for a site with no repository configured', async () => {
    let fetched = false;
    const healed = await autoHealNewContentTarget({ ...site, repo_owner: null, repo_name: null }, 'blog-outline', {
      fetchTree: async () => { fetched = true; return { files: [], truncated: false }; },
    });
    assert.equal(healed, null);
    assert.equal(fetched, false);
  });

  test('does nothing when the target already resolves — no wasted repo read', async () => {
    const already = { ...site, url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } } };
    let fetched = false;
    const healed = await autoHealNewContentTarget(already, 'blog-outline', {
      fetchTree: async () => { fetched = true; return { files: [], truncated: false }; },
    });
    assert.equal(healed, null);
    assert.equal(fetched, false);
  });

  // Real incident (2026-08-27): a site's real 10 "plausible" candidates
  // included .brain/.brain/session-logs (an agent's own internal notes) and
  // docs/docs/seo-aeo-implementation (repo documentation) alongside real
  // page directories — findContentDirectories' file-count bar alone cannot
  // tell these apart. These tests cover the two new, generic evidence tiers
  // that narrow it down using real repo content, not a directory-name guess.
  describe('autoHealNewContentTarget — real-page-evidence narrowing', () => {
    test('a dot-prefixed directory never qualifies, regardless of file count', async () => {
      const healed = await autoHealNewContentTarget(site, 'direct-answer', {
        fetchTree: treeOf(
          '.brain/a.md', '.brain/b.md', '.brain/c.md', '.brain/d.md',
          'src/answers/x.md', 'src/answers/y.md', 'src/answers/z.md',
        ),
        fetchFile: pageFetchFile,
      });
      assert.ok(healed, 'the only real candidate left after excluding .brain must still heal');
      assert.deepEqual(savedConfig.urlFileMap.newContentTargets['direct-answer'], { dir: 'src/answers', extension: '.md' });
    });

    test('a markdown directory with no page front matter is excluded as real notes, not content', async () => {
      const fetchFile = async (_s, path) => (
        path.startsWith('docs/') ? { content: 'Just a plain internal note, no front matter at all.' } : pageFetchFile()
      );
      const healed = await autoHealNewContentTarget(site, 'direct-answer', {
        fetchTree: treeOf(
          'docs/notes-a.md', 'docs/notes-b.md', 'docs/notes-c.md',
          'src/answers/x.md', 'src/answers/y.md', 'src/answers/z.md',
        ),
        fetchFile,
      });
      assert.ok(healed);
      assert.deepEqual(savedConfig.urlFileMap.newContentTargets['direct-answer'], { dir: 'src/answers', extension: '.md' });
    });

    test('a component/template extension is never subjected to the front-matter check', async () => {
      // .njk is unambiguous page-rendering evidence by construction — the
      // front-matter step must never fetch or exclude it.
      let fetchCalls = 0;
      const healed = await autoHealNewContentTarget(site, 'blog-outline', {
        fetchTree: treeOf('src/pages/a.njk', 'src/pages/b.njk', 'src/pages/c.njk'),
        fetchFile: async () => { fetchCalls++; return { content: '' }; },
      });
      assert.ok(healed);
      assert.equal(fetchCalls, 0, 'a single already-unambiguous candidate is never sampled at all');
    });

    test('remains genuinely ambiguous — and stays blocked — when two directories BOTH carry real page front matter', async () => {
      const healed = await autoHealNewContentTarget(site, 'direct-answer', {
        fetchTree: treeOf(
          'src/pages/resources/a.md', 'src/pages/resources/b.md', 'src/pages/resources/c.md',
          'src/pages/services/x.md', 'src/pages/services/y.md', 'src/pages/services/z.md',
        ),
        fetchFile: pageFetchFile,
      });
      assert.equal(healed, null, 'two real, equally-valid candidates must never be guessed between');
      assert.equal(savedConfig, null);
      assert.equal(recordedRepairs[0]?.outcome, 'ambiguous');
    });

    test('a fetch failure sampling one candidate is treated as unverifiable, not as evidence either way', async () => {
      const healed = await autoHealNewContentTarget(site, 'direct-answer', {
        fetchTree: treeOf(
          'docs/a.md', 'docs/b.md', 'docs/c.md',
          'src/answers/x.md', 'src/answers/y.md', 'src/answers/z.md',
        ),
        fetchFile: async (_s, path) => { if (path.startsWith('docs/')) throw new Error('network error'); return pageFetchFile(); },
      });
      assert.ok(healed, 'the unreachable candidate is dropped, not guessed at — the remaining real one still heals');
      assert.deepEqual(savedConfig.urlFileMap.newContentTargets['direct-answer'], { dir: 'src/answers', extension: '.md' });
    });
  });

  test('preserves existing newContentTargets/pages config rather than replacing the whole blob', async () => {
    const withExisting = {
      ...site,
      url_file_map: { pages: { '/x': { file: 'src/x.njk' } }, newContentTargets: { 'landing-page': { dir: 'src/pages', extension: '.njk' } } },
    };
    await autoHealNewContentTarget(withExisting, 'blog-outline', {
      fetchTree: treeOf('src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md'),
    });
    assert.deepEqual(savedConfig.urlFileMap.pages['/x'], { file: 'src/x.njk' });
    assert.deepEqual(savedConfig.urlFileMap.newContentTargets['landing-page'], { dir: 'src/pages', extension: '.njk' });
    assert.deepEqual(savedConfig.urlFileMap.newContentTargets['blog-outline'], { dir: 'src/blog', extension: '.md' });
  });
});
