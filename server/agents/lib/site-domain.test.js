import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hostnameOf, knownDomain, ownDomains, filterOwnDomainPages } from './site-domain.js';

// Regression coverage for a real report: a `sc-domain:` GSC property
// returns EVERY subdomain Search Console has data for. website_domain
// alone scopes that down to one hostname, but a site can legitimately
// have MORE than one real hostname of its own — e.g. Zunkiree Labs' own
// booking-engine product on zenly.zunkireelabs.com and its CRM product on
// edgex.zunkireelabs.com — while an unrelated project on a different
// subdomain (supreme-court.zunkireelabs.com) must still be excluded.
describe('ownDomains', () => {
  test('null when website_domain is unset, even with additional_own_domains present', () => {
    assert.equal(ownDomains({ website_domain: null, additional_own_domains: ['zenly.zunkireelabs.com'] }), null);
  });

  test('just the primary domain when additional_own_domains is empty/unset', () => {
    assert.deepEqual(ownDomains({ website_domain: 'zunkireelabs.com' }), ['zunkireelabs.com']);
    assert.deepEqual(ownDomains({ website_domain: 'zunkireelabs.com', additional_own_domains: [] }), ['zunkireelabs.com']);
  });

  test('includes every additional own domain alongside the primary', () => {
    const site = { website_domain: 'zunkireelabs.com', additional_own_domains: ['zenly.zunkireelabs.com', 'edgex.zunkireelabs.com'] };
    assert.deepEqual(ownDomains(site), ['zunkireelabs.com', 'zenly.zunkireelabs.com', 'edgex.zunkireelabs.com']);
  });

  test('normalizes a scheme-prefixed additional domain the same way knownDomain does', () => {
    const site = { website_domain: 'zunkireelabs.com', additional_own_domains: ['https://edgex.zunkireelabs.com/'] };
    assert.deepEqual(ownDomains(site), ['zunkireelabs.com', 'edgex.zunkireelabs.com']);
  });
});

describe('filterOwnDomainPages with a multi-domain set', () => {
  const rows = [
    { dim_value: 'https://zunkireelabs.com/pricing/' },
    { dim_value: 'https://www.zunkireelabs.com/about/' },
    { dim_value: 'https://zenly.zunkireelabs.com/features/' },
    { dim_value: 'https://edgex.zunkireelabs.com/crm/' },
    { dim_value: 'https://supreme-court.zunkireelabs.com/court/surkhetdc/legalmaterials' },
    { dim_value: 'https://dev-web.zunkireelabs.com/' },
  ];

  test('keeps the primary domain and every listed hero-product subdomain', () => {
    const site = { website_domain: 'zunkireelabs.com', additional_own_domains: ['zenly.zunkireelabs.com', 'edgex.zunkireelabs.com'] };
    const kept = filterOwnDomainPages(rows, ownDomains(site)).map((r) => r.dim_value);
    assert.deepEqual(kept, [
      'https://zunkireelabs.com/pricing/',
      'https://www.zunkireelabs.com/about/',
      'https://zenly.zunkireelabs.com/features/',
      'https://edgex.zunkireelabs.com/crm/',
    ]);
  });

  test('still excludes an unrelated subdomain not in additional_own_domains', () => {
    const site = { website_domain: 'zunkireelabs.com', additional_own_domains: ['zenly.zunkireelabs.com', 'edgex.zunkireelabs.com'] };
    const kept = filterOwnDomainPages(rows, ownDomains(site)).map((r) => hostnameOf(r.dim_value));
    assert.ok(!kept.includes('supreme-court.zunkireelabs.com'));
    assert.ok(!kept.includes('dev-web.zunkireelabs.com'));
  });

  test('a bare string still works exactly as before (backward compatible with knownDomain callers)', () => {
    assert.deepEqual(
      filterOwnDomainPages(rows, 'zunkireelabs.com').map((r) => r.dim_value),
      ['https://zunkireelabs.com/pricing/', 'https://www.zunkireelabs.com/about/']
    );
  });

  test('knownDomain(site) still returns the single primary domain, unaffected by additional_own_domains', () => {
    const site = { website_domain: 'zunkireelabs.com', additional_own_domains: ['zenly.zunkireelabs.com'] };
    assert.equal(knownDomain(site), 'zunkireelabs.com');
  });
});
