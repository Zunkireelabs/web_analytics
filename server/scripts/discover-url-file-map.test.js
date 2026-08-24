import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Same mock.module approach discover-file-mapping.test.js / auto-remediation.test.js
// already use — what's under test here is this script's own cross-hostname
// safety boundary (added 2026-08-24 alongside autoHealFileMapping's own
// version of the same fix), not the real DB/GitHub calls underneath it.

let site;
let searchRows;
let repoTreeFiles;
let fileContents; // path -> content string
let repoTreeCalls;

const realDb = await import(resolve('../db.js'));
mock.module(resolve('../db.js'), {
  namedExports: { ...realDb, pool: { end: async () => {} } },
});

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => site,
    getSearchPerformanceRange: async () => searchRows,
  },
});

const realGithubClient = await import(resolve('../github/client.js'));
mock.module(resolve('../github/client.js'), {
  namedExports: {
    ...realGithubClient,
    getFileContent: async (_s, path) => (fileContents[path] ? { content: fileContents[path] } : null),
    getRepoTree: async () => { repoTreeCalls++; return { files: repoTreeFiles, truncated: false }; },
  },
});

const { discoverSite, buildProposedUrlFileMap } = await import('./discover-url-file-map.js');

const FAQ_TEMPLATE = '---\nlayout: base.njk\n---\n{% for item in siteFaq %}\n{{ item.question }}\n{% endfor %}';
const FAQ_DATA = JSON.stringify([{ question: 'Q1', answer: 'A1' }]);

beforeEach(() => {
  repoTreeCalls = 0;
  fileContents = { 'src/_data/siteFaq.json': FAQ_DATA };
});

describe('discoverSite — the hostname-collision boundary (mirrors autoHealFileMapping)', () => {
  test('a page on a registered NON-PRIMARY hostname with no existing mapping is reported for manual review, never guessed at', async () => {
    site = {
      id: 1, name: 'Zunkiree Labs', repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main',
      website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'],
      url_file_map: {},
    };
    searchRows = [{ dim_value: 'https://edgex.zunkireelabs.com/pricing/' }];
    repoTreeFiles = ['src/pages/pricing.njk']; // a real, exact-name-matching file exists...

    const result = await discoverSite(1);

    assert.equal(repoTreeCalls, 0, 'must never even read the repo tree for a non-primary-hostname page — the refusal happens before any evidence gathering');
    assert.equal(result.resolved.length, 0);
  });

  test('the SAME page shape on the PRIMARY domain still discovers normally — the boundary is host-specific, not a general regression', async () => {
    site = {
      id: 1, name: 'Zunkiree Labs', repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main',
      website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'],
      url_file_map: {},
    };
    searchRows = [{ dim_value: 'https://zunkireelabs.com/pricing/' }];
    repoTreeFiles = ['src/pages/pricing.njk'];
    fileContents['src/pages/pricing.njk'] = FAQ_TEMPLATE;

    const result = await discoverSite(1);

    assert.equal(repoTreeCalls, 1, 'the primary domain is unaffected — discovery still runs');
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].discoveredFile, 'src/pages/pricing.njk');
  });

  test('a page on a registered non-primary hostname that ALREADY has an explicit hosts[] file mapping still gets its faq adapter proposed — this is verification of existing config, not cross-host guessing', async () => {
    site = {
      id: 1, name: 'Zunkiree Labs', repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main',
      website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'],
      url_file_map: {
        hosts: { 'edgex.zunkireelabs.com': { pages: { '/pricing': { file: 'src/edgex/pricing.njk' } } } },
      },
    };
    searchRows = [{ dim_value: 'https://edgex.zunkireelabs.com/pricing/' }];
    repoTreeFiles = [];
    fileContents['src/edgex/pricing.njk'] = FAQ_TEMPLATE;

    const result = await discoverSite(1);

    assert.equal(repoTreeCalls, 0, 'the file is already explicitly mapped — no repo-tree scan is needed at all');
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].discoveredFile, null, 'not newly discovered — it was already explicitly configured');
  });

  test('a URL on a hostname the site never registered at all is filtered out before discoverSite even sees it', async () => {
    site = {
      id: 1, name: 'Zunkiree Labs', repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main',
      website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'],
      url_file_map: {},
    };
    searchRows = [
      { dim_value: 'https://zunkireelabs.com/about/' },
      { dim_value: 'https://supreme-court.zunkireelabs.com/some-page/' },
    ];
    repoTreeFiles = ['src/pages/about.njk'];
    fileContents['src/pages/about.njk'] = FAQ_TEMPLATE;

    const result = await discoverSite(1);

    const allSeenPages = [...result.resolved, ...(result.resolved ?? [])].map((r) => r.page);
    assert.ok(!allSeenPages.some((p) => p?.includes('supreme-court')), 'a foreign hostname must never reach the discovery loop at all');
  });
});

describe('buildProposedUrlFileMap — writes into the SAME hostname scope resolveFile/resolveAdapter would read from', () => {
  const baseSite = (extra = {}) => ({
    id: 1, website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'],
    url_file_map: { pages: {}, hosts: {}, ...extra },
  });

  test('a primary-domain resolved item is written into the flat top-level pages, exactly as before', () => {
    const result = {
      site: baseSite(),
      resolved: [{ page: 'https://zunkireelabs.com/about/', path: '/about', config: { id: 'data-array-content' }, discoveredFile: 'src/pages/about.njk' }],
    };
    const cfg = buildProposedUrlFileMap(result);
    assert.equal(cfg.pages['/about'].file, 'src/pages/about.njk');
    assert.equal(cfg.pages['/about'].adapters.faq.id, 'data-array-content');
    assert.equal(cfg.hosts['edgex.zunkireelabs.com'], undefined, 'nothing should be written to the hosts namespace for a primary-domain page');
  });

  // The exact write-side mistake that caused the real
  // edgex.zunkireelabs.com collision (2026-08-24): this proves it can never
  // happen again through THIS script either, not just autoHealFileMapping.
  test('a non-primary-hostname resolved item is written into hosts[hostname].pages, NEVER into the flat top-level pages', () => {
    const result = {
      site: baseSite(),
      resolved: [{ page: 'https://edgex.zunkireelabs.com/pricing/', path: '/pricing', config: { id: 'data-array-content' }, discoveredFile: 'src/edgex/pricing.njk' }],
    };
    const cfg = buildProposedUrlFileMap(result);
    assert.equal(cfg.hosts['edgex.zunkireelabs.com'].pages['/pricing'].file, 'src/edgex/pricing.njk');
    assert.equal(cfg.pages['/pricing'], undefined, 'must NEVER land in the flat namespace — that is exactly the collision this whole fix exists to prevent');
  });

  test('mixed primary and non-primary resolved items land in their own correct, independent namespaces', () => {
    const result = {
      site: baseSite(),
      resolved: [
        { page: 'https://zunkireelabs.com/about/', path: '/about', config: { id: 'x' }, discoveredFile: 'src/pages/about.njk' },
        { page: 'https://edgex.zunkireelabs.com/about/', path: '/about', config: { id: 'y' }, discoveredFile: null },
      ],
    };
    // The edgex item has no existing hosts[] entry in this fixture (discoveredFile
    // is null only when resolveFile already succeeded in the real flow — here we're
    // testing the write in isolation, so pages[path] simply starts empty) —
    // proves the SAME path ("/about") on two hostnames never collides in the output.
    const cfg = buildProposedUrlFileMap(result);
    assert.equal(cfg.pages['/about'].adapters.faq.id, 'x');
    assert.equal(cfg.hosts['edgex.zunkireelabs.com'].pages['/about'].adapters.faq.id, 'y');
    assert.notEqual(cfg.pages['/about'], cfg.hosts['edgex.zunkireelabs.com'].pages['/about']);
  });

  test('preserves existing config in both namespaces rather than replacing them', () => {
    const result = {
      site: baseSite({
        pages: { '/contact': { file: 'src/pages/contact.njk' } },
        hosts: { 'edgex.zunkireelabs.com': { pages: { '/team': { file: 'src/edgex/team.njk' } } } },
      }),
      resolved: [{ page: 'https://edgex.zunkireelabs.com/pricing/', path: '/pricing', config: { id: 'x' }, discoveredFile: 'src/edgex/pricing.njk' }],
    };
    const cfg = buildProposedUrlFileMap(result);
    assert.deepEqual(cfg.pages['/contact'], { file: 'src/pages/contact.njk' });
    assert.deepEqual(cfg.hosts['edgex.zunkireelabs.com'].pages['/team'], { file: 'src/edgex/team.njk' });
    assert.equal(cfg.hosts['edgex.zunkireelabs.com'].pages['/pricing'].file, 'src/edgex/pricing.njk');
  });
});
