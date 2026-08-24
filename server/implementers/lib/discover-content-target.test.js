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
