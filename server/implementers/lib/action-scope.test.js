import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { actionScopeFor, familyWriteAllowed, checkSharedTemplateWrite } from './action-scope.js';
import { matchPaginationRoute } from './pagination-routes.js';

const GLOSSARY_ROUTE = {
  template: 'src/glossary/glossary-terms.njk', routePrefix: '/glossary', idField: 'id',
  alias: 'term', dataFile: 'src/_data/glossary.js', dataFileAmbiguous: false, layout: 'glossary-term.njk',
};

describe('actionScopeFor', () => {
  test('a handful of sitewide generators are global-by-design', () => {
    for (const id of ['analytics-install', 'security-headers', 'html-lang', 'llms-txt', 'robots-fix', 'sitemap']) {
      assert.equal(actionScopeFor(id), 'global-by-design', id);
    }
  });

  test('every ordinary content generator is page-specific by default', () => {
    for (const id of ['meta-title', 'faq', 'expand-content', 'qa-content', 'schema', 'internal-links', 'breadcrumbs', 'alt-text']) {
      assert.equal(actionScopeFor(id), 'page-specific', id);
    }
  });
});

describe('familyWriteAllowed', () => {
  test('true only when a matching pattern explicitly opts this exact action type in', () => {
    const site = { url_file_map: { patterns: [{ match: '^/glossary/', familyWrites: ['expand-content'] }] } };
    assert.equal(familyWriteAllowed(site, 'https://x.com/glossary/foo/', 'expand-content'), true);
    assert.equal(familyWriteAllowed(site, 'https://x.com/glossary/foo/', 'schema'), false, 'opt-in is per action type');
  });

  test('false with no patterns configured at all', () => {
    assert.equal(familyWriteAllowed({ url_file_map: {} }, 'https://x.com/glossary/foo/', 'expand-content'), false);
  });

  test('false when the pattern does not match this URL', () => {
    const site = { url_file_map: { patterns: [{ match: '^/compare/', familyWrites: ['expand-content'] }] } };
    assert.equal(familyWriteAllowed(site, 'https://x.com/glossary/foo/', 'expand-content'), false);
  });
});

describe('checkSharedTemplateWrite — the actual backstop decision', () => {
  const site = { url_file_map: { pages: { '/glossary/multi-tenant-saas': { file: 'src/glossary/glossary-terms.njk' } } } };
  const deps = { discoverRoutes: async () => [GLOSSARY_ROUTE], matchRoute: matchPaginationRoute };

  test('refuses a page-specific write into a discovered shared generator template', async () => {
    const refusal = await checkSharedTemplateWrite(
      site, 'https://x.com/glossary/multi-tenant-saas/', 'expand-content', 'src/glossary/glossary-terms.njk', deps
    );
    assert.equal(refusal.reason, 'shared-template-write');
    assert.match(refusal.error, /shared generator for every \/glossary\/\* page/);
    assert.match(refusal.error, /src\/_data\/glossary\.js/, 'names where the change actually belongs');
    assert.match(refusal.error, /familyWrites/, 'names the escape hatch, for a site that genuinely wants this');
  });

  test('allowed when filePath is NOT the route\'s own template, even inside the family', async () => {
    // A hypothetical per-page override file that happens to live under the
    // same family — the resolver's own concern, not this backstop's; this
    // backstop only refuses the EXACT shared file.
    const refusal = await checkSharedTemplateWrite(
      site, 'https://x.com/glossary/multi-tenant-saas/', 'expand-content', 'src/glossary/multi-tenant-saas.njk', deps
    );
    assert.equal(refusal, null);
  });

  test('allowed for a global-by-design action type regardless of the target', async () => {
    const refusal = await checkSharedTemplateWrite(
      site, 'https://x.com/glossary/multi-tenant-saas/', 'html-lang', 'src/glossary/glossary-terms.njk', deps
    );
    assert.equal(refusal, null);
  });

  test('allowed when the site explicitly opted this exact action type into family writes', async () => {
    const optedIn = {
      url_file_map: {
        ...site.url_file_map,
        patterns: [{ match: '^/glossary/', familyWrites: ['expand-content'] }],
      },
    };
    const refusal = await checkSharedTemplateWrite(
      optedIn, 'https://x.com/glossary/multi-tenant-saas/', 'expand-content', 'src/glossary/glossary-terms.njk', deps
    );
    assert.equal(refusal, null);
  });

  test('allowed when no discovered route claims this file at all', async () => {
    const refusal = await checkSharedTemplateWrite(
      site, 'https://x.com/glossary/multi-tenant-saas/', 'expand-content', 'src/glossary/glossary-terms.njk',
      { discoverRoutes: async () => [], matchRoute: matchPaginationRoute }
    );
    assert.equal(refusal, null);
  });

  test('a route-discovery failure fails OPEN, not into a false refusal', async () => {
    // Consistent with every other network-dependent gate in this codebase
    // (design-drift.js's checkTemplateFreshness, recommendation-gates.js's
    // healers) — an infra failure is not evidence, and treating it as a
    // refusal would block a page-specific fix on a transient GitHub outage.
    const refusal = await checkSharedTemplateWrite(
      site, 'https://x.com/glossary/multi-tenant-saas/', 'expand-content', 'src/glossary/glossary-terms.njk',
      { discoverRoutes: async () => { throw new Error('rate limited'); }, matchRoute: matchPaginationRoute }
    );
    assert.equal(refusal, null);
  });
});
