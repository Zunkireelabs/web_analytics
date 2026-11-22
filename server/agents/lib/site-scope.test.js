import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrefix, scopeOf, hasScope, pathOf, pathInScope, urlInScope, filterByScope, scopePageFilters } from './site-scope.js';

const marketplace = { scope_exclude_paths: ['/business'] };
const business = { scope_include_paths: ['business/'] };

describe('site scope', () => {
  test('an unscoped site (every existing site) passes everything through', () => {
    for (const s of [{}, null, undefined, { scope_include_paths: [], scope_exclude_paths: [] }]) {
      assert.equal(hasScope(s), false);
      assert.equal(urlInScope(s, 'https://zennly.io/business/x'), true);
      assert.equal(filterByScope([{ page: 'a' }], s).length, 1);
      assert.deepEqual(scopePageFilters(s), []);
    }
  });

  test('prefixes are normalised and "/" or blank mean nothing', () => {
    assert.equal(normalizePrefix('business/'), '/business');
    assert.equal(normalizePrefix(' /Business?x=1 '), '/Business');
    assert.equal(normalizePrefix('/'), null);
    assert.equal(normalizePrefix(''), null);
    assert.deepEqual(scopeOf({ scope_include_paths: ['/a/', 'a', '/'] }), { include: ['/a'], exclude: [] });
  });

  test('matches on a path-segment boundary, never a string prefix', () => {
    assert.equal(urlInScope(business, 'https://zennly.io/business'), true);
    assert.equal(urlInScope(business, 'https://zennly.io/business/'), true);
    assert.equal(urlInScope(business, 'https://zennly.io/business/blog/x'), true);
    assert.equal(urlInScope(business, 'https://zennly.io/businesses'), false);
    assert.equal(urlInScope(marketplace, 'https://zennly.io/businesses'), true);
  });

  test('marketplace owns everything except /business; business owns only /business', () => {
    const urls = ['https://zennly.io/', 'https://zennly.io/salons/hair', 'https://zennly.io/business/blog/a', 'https://zennly.io/business'];
    assert.deepEqual(urls.filter((u) => urlInScope(marketplace, u)), urls.slice(0, 2));
    assert.deepEqual(urls.filter((u) => urlInScope(business, u)), urls.slice(2));
  });

  test('exclude always wins over include', () => {
    const s = { scope_include_paths: ['/business'], scope_exclude_paths: ['/business/internal'] };
    assert.equal(urlInScope(s, 'https://x.test/business/blog'), true);
    assert.equal(urlInScope(s, 'https://x.test/business/internal/a'), false);
  });

  test('a bare path works and an unreadable URL passes through rather than being dropped', () => {
    assert.equal(urlInScope(marketplace, '/business/x'), false);
    assert.equal(urlInScope(marketplace, '/salons'), true);
    assert.equal(pathOf('not a url'), null);
    assert.equal(urlInScope(marketplace, 'not a url'), true);
    assert.equal(urlInScope(marketplace, undefined), true);
  });

  test('filterByScope reads dim_value, page, or a custom accessor', () => {
    assert.equal(filterByScope([{ dim_value: 'https://z.io/business/a' }, { dim_value: 'https://z.io/a' }], marketplace).length, 1);
    assert.equal(filterByScope([{ page: 'https://z.io/business/a' }], marketplace).length, 0);
    assert.equal(filterByScope([{ u: 'https://z.io/business/a' }], business, (r) => r.u).length, 1);
  });

  test('Search Console filters are RE2 regexes that match the same URLs', () => {
    const [inc] = scopePageFilters(business);
    const [exc] = scopePageFilters(marketplace);
    assert.equal(inc.operator, 'includingRegex');
    assert.equal(exc.operator, 'excludingRegex');
    const incRe = new RegExp(inc.expression);
    const excRe = new RegExp(exc.expression);
    for (const u of ['https://zennly.io/business', 'https://www.zennly.io/business/blog?x=1']) assert.ok(incRe.test(u) && excRe.test(u), u);
    for (const u of ['https://zennly.io/businesses', 'https://zennly.io/']) assert.ok(!incRe.test(u) && !excRe.test(u), u);
  });
});

describe('cross-site links', () => {
  test('only configured http(s) targets count, and a link may stay in scope or use one', async () => {
    const { crossSiteLinkTargets, linkTargetAllowed } = await import('./site-scope.js');
    const site = { scope_exclude_paths: ['/business'], url_file_map: { crossSiteLinks: [{ url: 'https://zennly.io/business/pricing' }, 'https://zennly.io/business', 'javascript:x', { url: 'nope' }, null] } };
    assert.deepEqual(crossSiteLinkTargets(site), ['https://zennly.io/business/pricing', 'https://zennly.io/business']);
    assert.deepEqual(crossSiteLinkTargets({}), []);
    assert.equal(linkTargetAllowed(site, 'https://zennly.io/salons'), true);
    assert.equal(linkTargetAllowed(site, 'https://zennly.io/business/pricing'), true);
    assert.equal(linkTargetAllowed(site, 'https://zennly.io/business/blog/x'), false);
    assert.equal(linkTargetAllowed({ scope_exclude_paths: ['/business'] }, 'https://zennly.io/business/pricing'), false);
  });
});

describe('GA4 scope filter', () => {
  test('unscoped is untouched; business include and marketplace exclude produce RE2 path filters', async () => {
    const { ga4ScopeFilter, withGa4Scope } = await import('./site-scope.js');
    const req = { property: 'p', dateRanges: [] };
    assert.equal(ga4ScopeFilter({}), null);
    assert.equal(withGa4Scope(req, {}), req);
    const inc = ga4ScopeFilter(business).filter.stringFilter;
    const exc = ga4ScopeFilter(marketplace).notExpression.filter.stringFilter;
    assert.equal(inc.matchType, 'FULL_REGEXP');
    const incRe = new RegExp(`^${inc.value}$`);
    for (const p of ['/business', '/business/', '/business/blog/x']) assert.ok(incRe.test(p), p);
    for (const p of ['/businesses', '/', '/salons']) assert.ok(!incRe.test(p), p);
    assert.equal(new RegExp(`^${exc.value}$`).test('/business/pricing'), true);
  });
  test('an existing filter is ANDed with the scope, never replaced', async () => {
    const { withGa4Scope } = await import('./site-scope.js');
    const existing = { filter: { fieldName: 'country', stringFilter: { value: 'India' } } };
    const out = withGa4Scope({ dimensionFilter: existing }, business);
    assert.equal(out.dimensionFilter.andGroup.expressions[0], existing);
    assert.equal(out.dimensionFilter.andGroup.expressions.length, 2);
  });
});

import { siblingSectionNote } from './site-scope.js';

describe('siblingSectionNote', () => {
  const marketplace = { website_domain: 'zennly.io', scope_exclude_paths: ['/business'] };
  const business = { website_domain: 'zennly.io', scope_include_paths: ['/business'] };
  test('is empty for an unscoped site', () => {
    assert.equal(siblingSectionNote({ website_domain: 'a.com' }), '');
  });
  test('tells the marketplace that /business is a different site', () => {
    const n = siblingSectionNote(marketplace, [{ name: 'Zennly Business' }]);
    assert.match(n, /zennly\.io except \/business/);
    assert.match(n, /\/business on zennly\.io is a different site/);
    assert.match(n, /Zennly Business/);
    assert.match(n, /never edit its pages/);
  });
  test('tells the business site the rest of the domain is a different site', () => {
    const n = siblingSectionNote(business);
    assert.match(n, /only the \/business section of zennly\.io/);
    assert.match(n, /Everything on zennly\.io outside \/business is a different site/);
  });
  test('allows links only to configured cross-site targets', () => {
    assert.match(siblingSectionNote(marketplace), /Do not link to it unless/);
    const n = siblingSectionNote({ ...marketplace, url_file_map: { crossSiteLinks: [{ url: 'https://zennly.io/business' }] } });
    assert.match(n, /link to it only at: https:\/\/zennly\.io\/business/);
  });
});
