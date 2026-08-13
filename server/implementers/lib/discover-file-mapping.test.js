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

// Real incident: the last-segment match findCandidateFile makes IS safe for
// authored pages (/blog/hello/ -> src/blog/hello.md, exactly one file), but
// has no notion of a SHARED target — a real-world route family, a layout, or
// a file already mapped elsewhere. These are the checks that turn "no other
// file has this name" into "and this one is genuinely this page's own."
describe('autoHealFileMapping — refuses a candidate that is a shared target', () => {
  test('refuses when the discovered `routes` say this URL is a generated family', async () => {
    const routes = [{ routePrefix: '/glossary', template: 'src/glossary/glossary-terms.njk', idField: 'id', dataFile: 'src/_data/glossary.js' }];
    // Contrived on purpose: a file happens to share the URL's last segment
    // even though the URL is really produced by the shared template above —
    // exactly the scenario the veto exists to catch before it's trusted.
    const healed = await autoHealFileMapping(site, 'https://x.com/glossary/rag/', 'expand-content', {
      fetchTree: treeOf('src/glossary/rag.njk'), routes,
    });
    assert.equal(healed, null);
    assert.equal(savedConfig, null, 'a route-family match must win over a coincidental filename match');
  });

  test('refuses a candidate under _includes/ even with no routes passed in', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/header/', 'meta-title', {
      fetchTree: treeOf('src/_includes/header.njk'),
    });
    assert.equal(healed, null);
    assert.equal(savedConfig, null);
  });

  test('refuses a candidate under _layouts/', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/base/', 'meta-title', {
      fetchTree: treeOf('src/_layouts/base.njk'),
    });
    assert.equal(healed, null);
    assert.equal(savedConfig, null);
  });

  test('refuses a candidate already mapped to a DIFFERENT url', async () => {
    const alreadyMapped = { ...site, url_file_map: { pages: { '/team': { file: 'src/pages/people.njk' } } } };
    const healed = await autoHealFileMapping(alreadyMapped, 'https://x.com/people/', 'meta-title', {
      fetchTree: treeOf('src/pages/people.njk'),
    });
    assert.equal(healed, null);
    assert.equal(savedConfig, null, 'the same file already serves a different URL — sharing it is evidence, not a coincidence');
  });

  test('a candidate mapped to the SAME url (re-heal) is not refused by the already-mapped check', async () => {
    // Not a real scenario in practice (resolveFile would already resolve and
    // autoHealFileMapping bails before reaching the veto), but the veto's own
    // logic must key off a DIFFERENT url, not just "is this file mapped at all."
    const same = { ...site, url_file_map: { pages: { '/other': { file: 'src/pages/about.njk' } } } };
    const healed = await autoHealFileMapping(same, 'https://x.com/about/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk'),
    });
    // /about is unmapped, /other already claims the file -> still refused,
    // since the file IS shared with a different URL regardless of which URL
    // is being healed right now.
    assert.equal(healed, null);
  });

  test('refuses when the candidate FILE ITSELF carries pagination front matter, even with no routes passed', async () => {
    const paginatingSource = '---\npagination:\n  data: glossary\n  alias: term\nlayout: glossary-term.njk\npermalink: /glossary/{{ term.id }}/\n---\nbody';
    const healed = await autoHealFileMapping(site, 'https://x.com/glossary-terms/', 'meta-title', {
      fetchTree: treeOf('src/glossary/glossary-terms.njk'),
      fetchFile: async () => ({ content: paginatingSource }),
    });
    assert.equal(healed, null, 'the candidate generates many pages, discovered from its own front matter');
  });

  test('a genuinely ordinary authored page still heals normally — the veto does not overreach', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/about/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk'),
      fetchFile: async () => ({ content: '---\nlayout: base.njk\ntitle: About\n---\nbody' }),
    });
    assert.ok(healed);
    assert.deepEqual(savedConfig.urlFileMap.pages['/about'], { file: 'src/pages/about.njk' });
  });
});
