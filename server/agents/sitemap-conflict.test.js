import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let sitemapEntries;
let signalsByPage; // page -> row (or partial)
let robotsTxtText; // raw robots.txt body, or null for "no robots.txt"

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});
mock.module(resolve('./lib/site-discovery.js'), {
  namedExports: {
    discoverSitemapEntries: async () => sitemapEntries,
    parseRobotsDisallowRules: (text) => {
      // Minimal real behavior: single "Disallow: /path" line support, enough
      // for these tests — the real function is covered by its own tests.
      const rules = (text || '').split('\n')
        .map((l) => l.trim())
        .filter((l) => l.toLowerCase().startsWith('disallow:'))
        .map((l) => l.slice('disallow:'.length).trim());
      return {
        isAllowed: (path) => !rules.some((r) => path.startsWith(r)),
        matchingDisallow: (path) => rules.find((r) => path.startsWith(r)) || null,
      };
    },
    originForSite: () => 'https://example.com',
  },
});
mock.module(resolve('./lib/page-content.js'), {
  namedExports: {
    fetchTextIfExists: async () => (robotsTxtText === null ? { ok: false } : { ok: true, text: robotsTxtText }),
    effortForGenerator: () => 'Low',
  },
});
mock.module(resolve('../store/technical-seo-checks.js'), {
  namedExports: {
    getTechnicalSeoSignalsForPages: async (siteId, { pages }) => pages.map((p) => signalsByPage.get(p)).filter(Boolean),
  },
});

const { run } = await import('./sitemap-conflict.js');

beforeEach(() => {
  site = { id: 1 };
  sitemapEntries = [];
  signalsByPage = new Map();
  robotsTxtText = null;
});

describe('sitemap-conflict agent', () => {
  test('insufficient-data when the sitemap has no entries yet', async () => {
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('insufficient-data when no sitemap URL has been inspected yet', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('skips a sitemap URL with no index_status yet, rather than guessing', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }, { loc: 'https://example.com/b/' }];
    signalsByPage.set('https://example.com/a/', { page: 'https://example.com/a/', index_status: null });
    signalsByPage.set('https://example.com/b/', { page: 'https://example.com/b/', index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/b/' } });
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('robots-blocked + a real matching Disallow rule found live -> auto-drafts a robots-fix Allow-override', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: null },
      last_impressions: 42,
    });
    robotsTxtText = 'User-agent: *\nDisallow: /a/';
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction.generatorId, 'robots-fix');
    assert.deepEqual(finding.recommendedAction.params, { pagePath: '/a/', blockedPattern: '/a/' });
    assert.equal(finding.reportOnly, null);
    assert.equal(result.facts.autoFixable, 1);
  });

  test('robots-blocked but the live robots.txt no longer confirms a matching rule -> stays reportOnly, never guesses a pattern', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: null },
    });
    robotsTxtText = 'User-agent: *\nDisallow: /somewhere-else/';
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction, null);
    assert.equal(finding.reportOnly.kind, 'sitemap-index-conflict');
  });

  test('blocked by a noindex meta tag (not robots.txt) -> stays reportOnly, no primitive for that yet', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'BLOCKED_BY_META_TAG', googleCanonical: null },
    });
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction, null);
  });

  test('non-canonical + no existing own canonical -> auto-drafts a canonical agreeing with Google\'s verdict', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/canonical-a/' },
      has_canonical: false,
    });
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction.generatorId, 'canonical');
    assert.deepEqual(finding.recommendedAction.params, { page: 'https://example.com/a/', canonicalTarget: 'https://example.com/canonical-a/' });
    assert.equal(finding.reportOnly, null);
  });

  test('non-canonical + page already has its own canonical -> stays reportOnly, a human decision already exists', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/canonical-a/' },
      has_canonical: true,
    });
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction, null);
    assert.equal(finding.reportOnly.kind, 'sitemap-index-conflict');
  });

  test('robots-blocked with no confirmable local pattern, but sitemap IS tracked -> falls back to sitemap-removal', async () => {
    site = { id: 1, url_file_map: { siteRoot: { sitemap: 'src/sitemap.njk' } } };
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: null },
    });
    robotsTxtText = 'User-agent: *\nDisallow: /somewhere-else/'; // doesn't confirm /a/
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction.generatorId, 'sitemap-removal');
    assert.deepEqual(finding.recommendedAction.params, { page: 'https://example.com/a/', removeUrls: ['https://example.com/a/'] });
    assert.equal(finding.reportOnly, null);
  });

  test('noindex meta tag block, sitemap IS tracked -> falls back to sitemap-removal instead of touching the noindex tag', async () => {
    site = { id: 1, url_file_map: { siteRoot: { sitemap: 'src/sitemap.njk' } } };
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'BLOCKED_BY_META_TAG', googleCanonical: null },
    });
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction.generatorId, 'sitemap-removal');
  });

  test('robots-blocked with no confirmable pattern AND no tracked sitemap -> stays reportOnly (nothing safe to do)', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: null },
    });
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction, null);
    assert.equal(finding.reportOnly.kind, 'sitemap-index-conflict');
  });

  test('non-canonical + own conflicting canonical, sitemap IS tracked -> falls back to sitemap-removal', async () => {
    site = { id: 1, url_file_map: { siteRoot: { sitemap: 'src/sitemap.njk' } } };
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/canonical-a/' },
      has_canonical: true,
    });
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction.generatorId, 'sitemap-removal');
    assert.equal(finding.reportOnly, null);
  });

  test('sitemapExcludeField verified for this site -> routes to sitemap-frontmatter-exclude instead of sitemap-removal', async () => {
    site = { id: 1, url_file_map: { siteRoot: { sitemap: 'src/sitemap.njk', sitemapExcludeField: 'excludeFromSitemap' } } };
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: null },
    });
    robotsTxtText = 'User-agent: *\nDisallow: /somewhere-else/'; // doesn't confirm /a/
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction.generatorId, 'sitemap-frontmatter-exclude');
    assert.deepEqual(finding.recommendedAction.params, { page: 'https://example.com/a/', field: 'excludeFromSitemap' });
    assert.equal(finding.reportOnly, null);
  });

  test('sitemapExcludeField alone (no static sitemap.siteRoot.sitemap at all) is still enough to auto-resolve', async () => {
    site = { id: 1, url_file_map: { siteRoot: { sitemapExcludeField: 'excludeFromSitemap' } } };
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/canonical-a/' },
      has_canonical: true,
    });
    const result = await run({ siteId: 1 });
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction.generatorId, 'sitemap-frontmatter-exclude');
    assert.equal(finding.reportOnly, null);
  });

  test('no finding when robots/indexing are fine and the google canonical matches the URL itself', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/a/' },
    });
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });
});
