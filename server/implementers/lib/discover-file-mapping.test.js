import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let savedConfig = null;

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

const { findCandidateFile, autoHealFileMapping, normalizedPath } = await import('./discover-file-mapping.js');

const site = { id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main', url_file_map: {} };
const treeOf = (...files) => async () => ({ files, truncated: false });

beforeEach(() => { savedConfig = null; });

describe('findCandidateFile — the never-guess evidence bar', () => {
  test('resolves when exactly one real filename matches the last URL segment', () => {
    const r = findCandidateFile('https://x.com/about/', ['src/pages/about.njk', 'src/pages/contact.njk']);
    assert.deepEqual(r, { kind: 'resolved', file: 'src/pages/about.njk' });
  });

  test('reports ambiguity rather than picking, when several files could match', () => {
    const r = findCandidateFile('https://x.com/about/', ['src/pages/about.njk', 'other/about.njk']);
    assert.equal(r.kind, 'ambiguous');
    assert.equal(r.candidates.length, 2);
  });

  test('narrows an ambiguous match using the URL\'s other segments as directory hints', () => {
    const r = findCandidateFile('https://x.com/blog/hello/', ['src/blog/hello.md', 'src/docs/hello.md']);
    assert.deepEqual(r, { kind: 'resolved', file: 'src/blog/hello.md' });
  });

  test('finds nothing when no real file matches — never invents a conventional path', () => {
    const r = findCandidateFile('https://x.com/nonexistent/', ['src/pages/about.njk']);
    assert.equal(r.kind, 'ambiguous');
    assert.deepEqual(r.candidates, []);
  });

  test('the site root has no last segment to match on', () => {
    assert.equal(findCandidateFile('https://x.com/', ['index.njk']).kind, 'ambiguous');
  });

  test('normalizedPath strips a trailing slash but preserves the root', () => {
    assert.equal(normalizedPath('https://x.com/about/'), '/about');
    assert.equal(normalizedPath('https://x.com/'), '/');
  });
});

describe('autoHealFileMapping', () => {
  test('persists a mapping when exactly one real file matches', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/about/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk', 'src/pages/contact.njk'),
    });

    assert.ok(healed, 'returns the updated site');
    assert.equal(savedConfig.siteId, 1);
    assert.deepEqual(savedConfig.urlFileMap.pages['/about'], { file: 'src/pages/about.njk' });
  });

  // The whole point of this module: a wrong mapping means a PR that edits the
  // wrong file in a customer's repository, which is worse than no PR at all.
  test('writes NOTHING when the match is ambiguous', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/about/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk', 'other/about.njk'),
    });

    assert.equal(healed, null);
    assert.equal(savedConfig, null, 'an ambiguous match must never be persisted');
  });

  test('writes NOTHING when no file matches at all', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/ghost/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk'),
    });

    assert.equal(healed, null);
    assert.equal(savedConfig, null);
  });

  test('preserves existing mappings rather than replacing the whole config', async () => {
    const withExisting = { ...site, url_file_map: { pages: { '/contact': { file: 'src/pages/contact.njk' } }, patterns: [{ match: '^/x$', file: 'x.njk' }] } };

    await autoHealFileMapping(withExisting, 'https://x.com/about/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk'),
    });

    assert.deepEqual(savedConfig.urlFileMap.pages['/contact'], { file: 'src/pages/contact.njk' });
    assert.deepEqual(savedConfig.urlFileMap.patterns, [{ match: '^/x$', file: 'x.njk' }]);
    assert.equal(savedConfig.urlFileMap.pages['/about'].file, 'src/pages/about.njk');
  });

  test('does nothing for a site with no repository configured', async () => {
    let fetched = false;
    const healed = await autoHealFileMapping({ ...site, repo_owner: null, repo_name: null }, 'https://x.com/about/', 'meta-title', {
      fetchTree: async () => { fetched = true; return { files: [], truncated: false }; },
    });

    assert.equal(healed, null);
    assert.equal(fetched, false, 'must not reach GitHub at all');
  });

  test('does nothing when the page already resolves — no wasted repo read', async () => {
    const alreadyMapped = { ...site, url_file_map: { pages: { '/about': { file: 'src/pages/about.njk' } } } };
    let fetched = false;

    const healed = await autoHealFileMapping(alreadyMapped, 'https://x.com/about/', 'meta-title', {
      fetchTree: async () => { fetched = true; return { files: [], truncated: false }; },
    });

    assert.equal(healed, null);
    assert.equal(fetched, false);
    assert.equal(savedConfig, null);
  });

  test('defers to an adapter route instead of writing a file mapping over it', async () => {
    const adapterRouted = {
      ...site,
      url_file_map: { pages: { '/about': { adapters: { 'meta-title': { id: 'data-array-content' } } } } },
    };

    const healed = await autoHealFileMapping(adapterRouted, 'https://x.com/about/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk'),
    });

    assert.equal(healed, null);
    assert.equal(savedConfig, null, 'an adapter-routed page is a separate concern, not a missing file mapping');
  });
});
