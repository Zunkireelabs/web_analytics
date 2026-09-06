import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pageFilterGroups, detectQueryDimensionLeakage } from './gsc.js';

// Regression coverage for a real report: a `sc-domain:` GSC property
// returns EVERY subdomain Search Console has data for, including an
// entirely unrelated client project hosted on a subdomain of the same root
// domain (e.g. supreme-court.zunkireelabs.com showing up in Zunkiree Labs'
// own SEO recommendations). pageFilterGroups is what fetchGscForDate uses
// to scope every Search Console API call to just the site's real hostname.
describe('pageFilterGroups', () => {
  test('undefined (no filter) when no domain is configured — same "pass through" convention as filterOwnDomainPages', () => {
    assert.equal(pageFilterGroups(null), undefined);
    assert.equal(pageFilterGroups(''), undefined);
  });

  test('matches the exact apex domain and its www subdomain', () => {
    const [group] = pageFilterGroups('zunkireelabs.com');
    const re = new RegExp(group.filters[0].expression);
    assert.match('https://zunkireelabs.com/', re);
    assert.match('https://www.zunkireelabs.com/about', re);
    assert.match('http://zunkireelabs.com', re);
  });

  test('does NOT match an unrelated subdomain of the same root domain', () => {
    const [group] = pageFilterGroups('zunkireelabs.com');
    const re = new RegExp(group.filters[0].expression);
    assert.doesNotMatch('https://supreme-court.zunkireelabs.com/court/surkhetdc/legalmaterials', re);
  });

  test('does NOT match a different domain that merely contains the same substring', () => {
    const [group] = pageFilterGroups('zunkireelabs.com');
    const re = new RegExp(group.filters[0].expression);
    assert.doesNotMatch('https://notzunkireelabs.com/', re);
    assert.doesNotMatch('https://zunkireelabs.com.evil.tld/', re);
  });

  test('escapes regex-special characters in the domain', () => {
    const [group] = pageFilterGroups('my-site.example.com');
    assert.doesNotThrow(() => new RegExp(group.filters[0].expression));
  });

  // A site can have more than one real hostname of its own — e.g. Zunkiree
  // Labs' own booking-engine product on zenly.zunkireelabs.com and its CRM
  // product on edgex.zunkireelabs.com — passed as the array ownDomains(site)
  // returns, alongside the primary domain.
  test('accepts an array of own domains and matches any of them', () => {
    const [group] = pageFilterGroups(['zunkireelabs.com', 'zenly.zunkireelabs.com', 'edgex.zunkireelabs.com']);
    const re = new RegExp(group.filters[0].expression);
    assert.match('https://zunkireelabs.com/pricing/', re);
    assert.match('https://zenly.zunkireelabs.com/features/', re);
    assert.match('https://edgex.zunkireelabs.com/crm/', re);
  });

  test('still excludes an unrelated subdomain not in the array', () => {
    const [group] = pageFilterGroups(['zunkireelabs.com', 'zenly.zunkireelabs.com', 'edgex.zunkireelabs.com']);
    const re = new RegExp(group.filters[0].expression);
    assert.doesNotMatch('https://supreme-court.zunkireelabs.com/court/surkhetdc/legalmaterials', re);
    assert.doesNotMatch('https://dev-web.zunkireelabs.com/', re);
  });

  test('undefined when the array is empty', () => {
    assert.equal(pageFilterGroups([]), undefined);
  });
});

// Real, observed gap: dimensionFilterGroups' page-dimension filter did not
// reliably exclude a foreign subdomain on the combined query+page+device+
// country request, even though the identical filter correctly excluded it
// on the single-dimension 'page' request in the same function — confirmed
// live. queryPageRowsOwn re-filters that one call in code so it can never
// leak a foreign page, but a bare query-dimension row has no page/URL on
// it at all, so it can't be hostname-checked the same way. This tripwire
// is the closest indirect check available for that one blind spot.
describe('detectQueryDimensionLeakage', () => {
  test('flags a query whose unfiltered impressions far exceed its filtered total', () => {
    const queries = [{ dim_value: 'उच्च अदालत दैनिक पेशी सूची', impressions: 500 }];
    const queryPages = []; // none of it ever showed up in the hard-filtered, own-domain data
    const suspicious = detectQueryDimensionLeakage(queries, queryPages);
    assert.equal(suspicious.length, 1);
    assert.equal(suspicious[0].query, 'उच्च अदालत दैनिक पेशी सूची');
    assert.equal(suspicious[0].unfilteredImpressions, 500);
    assert.equal(suspicious[0].filteredImpressions, 0);
  });

  test('does not flag a query whose filtered total already accounts for its unfiltered total', () => {
    const queries = [{ dim_value: 'zunkiree labs', impressions: 100 }];
    const queryPages = [
      { query: 'zunkiree labs', page: 'https://zunkireelabs.com/', impressions: 60 },
      { query: 'zunkiree labs', page: 'https://zunkireelabs.com/about/', impressions: 40 },
    ];
    assert.deepEqual(detectQueryDimensionLeakage(queries, queryPages), []);
  });

  test('tolerates a real, benign gap from queryPages\' 250-row cap on a long-tail query', () => {
    const queries = [{ dim_value: 'gaas vs saas', impressions: 100 }];
    const queryPages = [{ query: 'gaas vs saas', page: 'https://zunkireelabs.com/blog/gaas-vs-saas/', impressions: 80 }];
    // 100 vs 80 is well within the default 1.5x tolerance — not suspicious.
    assert.deepEqual(detectQueryDimensionLeakage(queries, queryPages), []);
  });

  test('ignores single-digit noise below the minimum impression floor', () => {
    const queries = [{ dim_value: 'some rare typo query', impressions: 5 }];
    assert.deepEqual(detectQueryDimensionLeakage(queries, []), []);
  });
});
