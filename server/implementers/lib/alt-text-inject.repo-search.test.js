import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// computeAltTextMerge's Layer 2 fallback needs a real GitHub read
// (getFileContent) and a repo-local search (searchRepoLocalForStrings) —
// mocked here so this exercises the real fallback logic without a live
// repo. Both mocks are registered BEFORE alt-text-inject.js is imported
// (ESM static imports bind at module-link time).
const resolve = (p) => new URL(p, import.meta.url).href;

let filesByPath = {};
let searchMatches = [];

const realClient = await import('../../github/client.js');
const realSearch = await import('./repo-local-search.js');

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    ...realClient,
    getFileContent: async (_site, path) => (filesByPath[path] ? { content: filesByPath[path] } : null),
  },
});
mock.module(resolve('./repo-local-search.js'), {
  namedExports: {
    ...realSearch,
    searchRepoLocalForStrings: async () => ({ matches: searchMatches, scanned: filesByPath ? Object.keys(filesByPath).length : 0, truncatedCoverage: false }),
  },
});

const { computeAltTextMerge } = await import('./alt-text-inject.js');

const site = {
  id: 1,
  url_file_map: { pages: { '/services/data-systems/': { file: 'src/pages/services/data-systems.njk' } } },
};

const originalTag = '<img src="/assets/data-systems-hero.webp" alt="" class="absolute right-0 top-0 w-full h-full object-cover object-right" aria-hidden="true">';

const draft = {
  content: {
    page: 'https://example.com/services/data-systems/',
    items: [{ alt: 'Data pipelines dashboard', src: '/assets/data-systems-hero.webp', originalTag }],
  },
};

describe('computeAltTextMerge — Layer 2 repo-local-search fallback', () => {
  test('the anchor is in a shared component, not the page\'s own thin wrapper file — Layer 2 finds it', async () => {
    filesByPath = {
      'src/pages/services/data-systems.njk': '---\nlayout: service.njk\n---\n',
      'src/_includes/layouts/service.njk': `<section>${originalTag}</section>`,
    };
    searchMatches = ['src/_includes/layouts/service.njk'];

    const result = await computeAltTextMerge(site, draft, 'main');
    assert.equal(result.ok, true);
    assert.equal(result.filePath, 'src/_includes/layouts/service.njk');
    assert.match(result.newContent, /alt="Data pipelines dashboard"/);
  });

  test('a candidate file found by search but missing the anchor is skipped, not applied', async () => {
    filesByPath = {
      'src/pages/services/data-systems.njk': '---\nlayout: service.njk\n---\n',
      'src/_includes/layouts/other.njk': '<section>unrelated content</section>',
    };
    searchMatches = ['src/_includes/layouts/other.njk'];

    const result = await computeAltTextMerge(site, draft, 'main');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'source-anchor-not-found');
  });

  test('genuinely absent everywhere (e.g. a build-time-hashed src, or a data-driven template var) fails honestly', async () => {
    filesByPath = { 'src/pages/services/data-systems.njk': '---\nlayout: service.njk\n---\n' };
    searchMatches = [];

    const result = await computeAltTextMerge(site, draft, 'main');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'source-anchor-not-found');
  });
});
