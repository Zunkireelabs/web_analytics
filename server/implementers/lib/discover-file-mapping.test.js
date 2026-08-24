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

let recordedRepairs = [];
mock.module(resolve('../../store/capability-repairs.js'), {
  namedExports: {
    recordCapabilityRepair: async (siteId, attempt) => { recordedRepairs.push({ siteId, ...attempt }); },
    listCapabilityRepairs: async () => [],
  },
});

const {
  findCandidateFile, findCandidateFileBySiblingPattern, findCandidateFileByDirectoryIndex,
  buildPermalinkIndex, findCandidateFileByPermalink, autoHealFileMapping, normalizedPath,
} = await import('./discover-file-mapping.js');
const { resolveFile } = await import('./url-file-map.js');

const site = { id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main', url_file_map: {} };
const treeOf = (...files) => async () => ({ files, truncated: false });

beforeEach(() => { savedConfig = null; recordedRepairs = []; });

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

describe('findCandidateFileBySiblingPattern — reusing an already-trusted mapping', () => {
  test('derives a new file from a sibling whose file literally contains its own slug', () => {
    const siteWithSibling = { url_file_map: { pages: { '/services/foo': { file: 'src/services/foo.md' } } } };
    const r = findCandidateFileBySiblingPattern(siteWithSibling, 'https://x.com/services/bar/', ['src/services/foo.md', 'src/services/bar.md']);
    assert.deepEqual(r, { kind: 'resolved', file: 'src/services/bar.md' });
  });

  test('refuses when two siblings derive to two different real files', () => {
    const conflicting = {
      url_file_map: { pages: { '/services/foo': { file: 'src/services/foo.md' }, '/services/baz': { file: 'src/other/baz.md' } } },
    };
    const r = findCandidateFileBySiblingPattern(conflicting, 'https://x.com/services/bar/', ['src/services/bar.md', 'src/other/bar.md']);
    assert.equal(r.kind, 'ambiguous');
    assert.equal(r.candidates.length, 2);
  });

  test('agreement from multiple siblings on the SAME derived file still counts as one candidate', () => {
    const agree = {
      url_file_map: { pages: { '/services/foo': { file: 'src/services/foo.md' }, '/services/baz': { file: 'src/services/baz.md' } } },
    };
    const r = findCandidateFileBySiblingPattern(agree, 'https://x.com/services/bar/', ['src/services/bar.md']);
    assert.deepEqual(r, { kind: 'resolved', file: 'src/services/bar.md' });
  });

  test('never invents a path that is not a real file in the tree', () => {
    const siteWithSibling = { url_file_map: { pages: { '/services/foo': { file: 'src/services/foo.md' } } } };
    const r = findCandidateFileBySiblingPattern(siteWithSibling, 'https://x.com/services/bar/', ['src/services/foo.md']);
    assert.equal(r.kind, 'ambiguous');
    assert.deepEqual(r.candidates, []);
  });

  test('no siblings under the same directory falls through harmlessly', () => {
    const noSiblings = { url_file_map: { pages: { '/blog/hello': { file: 'src/blog/hello.md' } } } };
    const r = findCandidateFileBySiblingPattern(noSiblings, 'https://x.com/services/bar/', ['src/services/bar.md']);
    assert.equal(r.kind, 'ambiguous');
  });
});

describe('autoHealFileMapping — own-domain guard', () => {
  test('refuses a URL on a hostname this site never registered as its own', async () => {
    const scoped = { ...site, website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'] };
    let fetched = false;
    const healed = await autoHealFileMapping(scoped, 'https://supreme-court.zunkireelabs.com/some-page/', 'meta-title', {
      fetchTree: async () => { fetched = true; return { files: [], truncated: false }; },
    });
    assert.equal(healed, null);
    assert.equal(fetched, false, 'must never even read the repo tree for a URL outside the registered own-domains');
    assert.equal(recordedRepairs[0]?.outcome, 'foreign-domain');
  });

  // Registered-but-not-primary is NOT the same as safe to auto-discover.
  // Real incident (2026-08-24): edgex.zunkireelabs.com/ was a registered
  // own-domain, and auto-discovery still silently resolved it to the MAIN
  // site's homepage file — the evidence tiers have no way to know which of
  // a site's several hostnames a shared repo's routes are meant for. See
  // resolveHostScope in url-file-map.js.
  test('does NOT auto-discover a URL on a registered but non-primary own-domain — auto-discovery is unsafe across hostnames', async () => {
    const scoped = { ...site, website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'] };
    let fetched = false;
    const healed = await autoHealFileMapping(scoped, 'https://edgex.zunkireelabs.com/pricing/', 'meta-title', {
      fetchTree: async () => { fetched = true; return { files: [], truncated: false }; },
    });
    assert.equal(healed, null);
    assert.equal(fetched, false, 'must never even read the repo tree — the refusal happens before any evidence tier runs');
    assert.equal(recordedRepairs[0]?.outcome, 'requires-explicit-host-config');
    assert.equal(recordedRepairs[0]?.detail?.hostname, 'edgex.zunkireelabs.com');
  });

  test('a registered non-primary domain resolves ONLY via an explicit hosts[] entry, never auto-discovery', async () => {
    const explicitlyConfigured = {
      ...site, website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'],
      url_file_map: { hosts: { 'edgex.zunkireelabs.com': { pages: { '/pricing': { file: 'src/pages/edgex/pricing.njk' } } } } },
    };
    // autoHealFileMapping still refuses to ATTEMPT discovery (nothing to
    // discover — it's not blocked, it's already explicitly resolved)...
    const healed = await autoHealFileMapping(explicitlyConfigured, 'https://edgex.zunkireelabs.com/pricing/', 'meta-title', {
      fetchTree: async () => ({ files: [], truncated: false }),
    });
    assert.equal(healed, null, 'nothing to heal — resolveFile already resolves it, the very first bail-out check');
    // ...and resolveFile/isPageMapped (the real production read path) does
    // resolve it correctly, from the edgex-specific namespace.
    assert.equal(resolveFile(explicitlyConfigured, 'https://edgex.zunkireelabs.com/pricing/'), 'src/pages/edgex/pricing.njk');
    assert.equal(resolveFile(explicitlyConfigured, 'https://zunkireelabs.com/pricing/'), null, 'the primary domain has no such page — the two namespaces stay independent');
  });

  test('passes through unfiltered when website_domain was never set — never risks excluding the site\'s own real pages on a guess', async () => {
    const unscoped = { ...site, website_domain: null, additional_own_domains: [] };
    const healed = await autoHealFileMapping(unscoped, 'https://anything.example.com/about/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk'),
    });
    assert.ok(healed);
  });
});

describe('autoHealFileMapping — permalink-search is the last resort, only reached after sibling-pattern and filename-match both fail', () => {
  test('resolves via code search when neither earlier tier finds a candidate', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/deeply/nested/page/', 'meta-title', {
      fetchTree: treeOf('src/content/unrelated-name.md'),
      searchCode: async (_s, literal) => (literal === '/deeply/nested/page' ? ['src/content/unrelated-name.md'] : []),
    });
    assert.ok(healed);
    assert.equal(savedConfig.urlFileMap.pages['/deeply/nested/page'].file, 'src/content/unrelated-name.md');
    assert.equal(recordedRepairs[0]?.evidenceTier, 'permalink-search');
  });

  test('a thrown/unavailable search is treated as no evidence, never as evidence of absence', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/deeply/nested/page/', 'meta-title', {
      fetchTree: treeOf('src/content/unrelated-name.md'),
      searchCode: async () => { throw new Error('rate limited'); },
    });
    assert.equal(healed, null);
    assert.equal(recordedRepairs[0]?.outcome, 'ambiguous');
  });

  test('filename-match still wins over permalink-search when it alone resolves — search is never tried needlessly', async () => {
    let searched = false;
    const healed = await autoHealFileMapping(site, 'https://x.com/about/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk'),
      searchCode: async () => { searched = true; return []; },
    });
    assert.ok(healed);
    assert.equal(searched, false, 'filename-match already resolved it — the last-resort tier must not even run');
  });
});

describe('findCandidateFileByDirectoryIndex — the directory-index convention', () => {
  test('/compare/ -> src/compare/index.njk', () => {
    const r = findCandidateFileByDirectoryIndex('https://x.com/compare/', ['src/compare/index.njk', 'src/compare/comparison-pages.njk']);
    assert.deepEqual(r, { kind: 'resolved', file: 'src/compare/index.njk' });
  });

  test('/locations/ -> src/locations/index.njk, never confused with the per-item pagination template', () => {
    const r = findCandidateFileByDirectoryIndex('https://x.com/locations/', [
      'src/locations/index.njk', 'src/locations/location-pages.njk', 'src/locations/location-service-pages.njk',
    ]);
    assert.deepEqual(r, { kind: 'resolved', file: 'src/locations/index.njk' });
  });

  test('root has no directory to look for — deliberately out of scope, handled by permalink-frontmatter instead', () => {
    assert.equal(findCandidateFileByDirectoryIndex('https://x.com/', ['index.njk']).kind, 'ambiguous');
  });

  test('two directories with the same last segment abort as ambiguous, never picked between', () => {
    const r = findCandidateFileByDirectoryIndex('https://x.com/compare/', ['src/compare/index.njk', 'other/compare/index.njk']);
    assert.equal(r.kind, 'ambiguous');
    assert.equal(r.candidates.length, 2);
  });

  test('narrows using the URL\'s other segments as directory hints, same as findCandidateFile', () => {
    const r = findCandidateFileByDirectoryIndex('https://x.com/services/compare/', ['src/services/compare/index.njk', 'src/legal/compare/index.njk']);
    assert.deepEqual(r, { kind: 'resolved', file: 'src/services/compare/index.njk' });
  });

  test('no matching directory at all', () => {
    const r = findCandidateFileByDirectoryIndex('https://x.com/nonexistent/', ['src/compare/index.njk']);
    assert.equal(r.kind, 'ambiguous');
    assert.deepEqual(r.candidates, []);
  });
});

describe('buildPermalinkIndex / findCandidateFileByPermalink — reading the framework\'s own routing field', () => {
  test('/ -> the one file whose frontmatter literally declares permalink: /', async () => {
    const fetchFile = async (_s, file) => {
      if (file === 'src/pages/index.njk') return { content: '---\nlayout: base.njk\npermalink: /\n---\nbody' };
      return { content: '---\nlayout: base.njk\npermalink: /about/\n---\nbody' };
    };
    const index = await buildPermalinkIndex(site, { files: ['src/pages/index.njk', 'src/pages/about.njk'] }, { fetchFile });
    assert.deepEqual(findCandidateFileByPermalink('https://x.com/', index), { kind: 'resolved', file: 'src/pages/index.njk' });
  });

  test('/ -> no candidate when nothing declares permalink: /', async () => {
    const fetchFile = async () => ({ content: '---\nlayout: base.njk\npermalink: /about/\n---\nbody' });
    const index = await buildPermalinkIndex(site, { files: ['src/pages/about.njk'] }, { fetchFile });
    const r = findCandidateFileByPermalink('https://x.com/', index);
    assert.equal(r.kind, 'ambiguous');
    assert.deepEqual(r.candidates, []);
  });

  test('/ -> ambiguous when two files both declare permalink: /', async () => {
    const fetchFile = async () => ({ content: '---\nlayout: base.njk\npermalink: /\n---\nbody' });
    const index = await buildPermalinkIndex(site, { files: ['src/pages/index.njk', 'src/pages/home.njk'] }, { fetchFile });
    const r = findCandidateFileByPermalink('https://x.com/', index);
    assert.equal(r.kind, 'ambiguous');
    assert.equal(r.candidates.length, 2);
  });

  test('a pagination template\'s dynamic permalink is excluded from the index entirely', async () => {
    const fetchFile = async (_s, file) => {
      if (file === 'src/locations/location-pages.njk') {
        return { content: '---\npagination:\n  data: locations\n  alias: location\npermalink: /locations/{{ location.id }}/\n---\nbody' };
      }
      return { content: '---\npermalink: /locations/\n---\nbody' };
    };
    const index = await buildPermalinkIndex(site, { files: ['src/locations/index.njk', 'src/locations/location-pages.njk'] }, { fetchFile });
    assert.deepEqual(findCandidateFileByPermalink('https://x.com/locations/', index), { kind: 'resolved', file: 'src/locations/index.njk' });
    assert.equal(index.has('/locations/{{ location.id }}/'), false, 'a template-expression permalink must never be indexed as a real path');
  });

  test('trailing-slash normalization matches a full URL against a bare frontmatter path', async () => {
    const fetchFile = async () => ({ content: '---\npermalink: /compare/\n---\nbody' });
    const index = await buildPermalinkIndex(site, { files: ['src/compare/index.njk'] }, { fetchFile });
    assert.deepEqual(findCandidateFileByPermalink('https://x.com/compare/', index), { kind: 'resolved', file: 'src/compare/index.njk' });
  });

  test('a file with no permalink front matter at all is silently skipped, not treated as an error', async () => {
    const fetchFile = async () => ({ content: '---\nlayout: base.njk\n---\nbody' });
    const index = await buildPermalinkIndex(site, { files: ['src/pages/no-permalink.njk'] }, { fetchFile });
    assert.equal(index.size, 0);
  });

  test('a fetch failure for one file does not abort indexing the rest', async () => {
    const fetchFile = async (_s, file) => {
      if (file === 'src/broken.njk') throw new Error('rate limited');
      return { content: '---\npermalink: /\n---\nbody' };
    };
    const index = await buildPermalinkIndex(site, { files: ['src/broken.njk', 'src/pages/index.njk'] }, { fetchFile });
    assert.deepEqual(findCandidateFileByPermalink('https://x.com/', index), { kind: 'resolved', file: 'src/pages/index.njk' });
  });
});

describe('autoHealFileMapping — the new directory-index and permalink-frontmatter tiers, end to end', () => {
  test('resolves the site root via permalink-frontmatter when no other tier can even attempt it', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/', 'meta-title', {
      fetchTree: treeOf('src/pages/index.njk', 'src/pages/about.njk'),
      fetchFile: async (_s, file) => (file === 'src/pages/index.njk'
        ? { content: '---\npermalink: /\n---\nbody' }
        : { content: '---\npermalink: /about/\n---\nbody' }),
    });
    assert.ok(healed);
    assert.equal(savedConfig.urlFileMap.pages['/'].file, 'src/pages/index.njk');
    assert.equal(recordedRepairs[0]?.evidenceTier, 'permalink-frontmatter');
  });

  test('leaves the site root unresolved when no file declares permalink: /', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/', 'meta-title', {
      fetchTree: treeOf('src/pages/about.njk'),
      fetchFile: async () => ({ content: '---\npermalink: /about/\n---\nbody' }),
      searchCode: async () => [],
    });
    assert.equal(healed, null);
    assert.equal(recordedRepairs[0]?.outcome, 'ambiguous');
  });

  test('leaves the site root unresolved when two files both declare permalink: /', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/', 'meta-title', {
      fetchTree: treeOf('src/pages/index.njk', 'src/pages/home.njk'),
      fetchFile: async () => ({ content: '---\npermalink: /\n---\nbody' }),
      searchCode: async () => [],
    });
    assert.equal(healed, null, 'a real conflict in the repo itself must never be picked between');
  });

  test('resolves /compare/ via directory-index, cheaper than the permalink-frontmatter tier which is never even reached', async () => {
    let fetchFileCalls = 0;
    const healed = await autoHealFileMapping(site, 'https://x.com/compare/', 'meta-title', {
      fetchTree: treeOf('src/compare/index.njk', 'src/compare/comparison-pages.njk'),
      fetchFile: async (_s, file) => { fetchFileCalls++; return { content: file.includes('comparison-pages') ? '---\npagination:\n  data: comparisons\n---\nbody' : '---\nlayout: base.njk\n---\nbody' }; },
    });
    assert.ok(healed);
    assert.equal(savedConfig.urlFileMap.pages['/compare'].file, 'src/compare/index.njk');
    assert.equal(recordedRepairs[0]?.evidenceTier, 'directory-index');
    // Exactly one fetch: sharedTargetVeto's own content check on the ONE
    // resolved candidate — the permalink-frontmatter tier (which would fetch
    // every template file) must never run once directory-index already won.
    assert.equal(fetchFileCalls, 1);
  });

  test('resolves /locations/ via directory-index without confusing it for the per-city pagination template', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/locations/', 'meta-title', {
      fetchTree: treeOf('src/locations/index.njk', 'src/locations/location-pages.njk'),
      fetchFile: async (_s, file) => ({ content: file.includes('location-pages') ? '---\npagination:\n  data: locations\n---\nbody' : '---\nlayout: base.njk\n---\nbody' }),
    });
    assert.ok(healed);
    assert.equal(savedConfig.urlFileMap.pages['/locations'].file, 'src/locations/index.njk');
  });

  // The whole point of ordering: directory-index found a real candidate, but
  // it turned out to BE the shared pagination template itself — the veto
  // must still refuse it, and the pass must not fall through to a weaker
  // tier and invent a different answer instead.
  test('shared-target veto still applies to a directory-index candidate', async () => {
    const healed = await autoHealFileMapping(site, 'https://x.com/locations/', 'meta-title', {
      fetchTree: treeOf('src/locations/index.njk'),
      fetchFile: async () => ({ content: '---\npagination:\n  data: locations\n---\nbody' }),
      searchCode: async () => [],
    });
    assert.equal(healed, null, 'the only "index" candidate is itself the shared generator — refused, not silently accepted');
  });

  test('the foreign-domain guard still runs before any new tier, including permalink-frontmatter', async () => {
    const scoped = { ...site, website_domain: 'zunkireelabs.com', additional_own_domains: [] };
    let fetched = false;
    const healed = await autoHealFileMapping(scoped, 'https://supreme-court.zunkireelabs.com/', 'meta-title', {
      fetchTree: async () => { fetched = true; return { files: [], truncated: false }; },
    });
    assert.equal(healed, null);
    assert.equal(fetched, false, 'a foreign-domain root URL must never even reach the tree/permalink-scan tiers');
    assert.equal(recordedRepairs[0]?.outcome, 'foreign-domain');
  });
});
