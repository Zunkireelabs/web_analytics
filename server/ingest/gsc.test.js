import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pageFilterGroups } from './gsc.js';

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
});
