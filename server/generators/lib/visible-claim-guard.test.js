import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findVisibleClaimIssues } from './visible-claim-guard.js';

const site = { url_file_map: { siteRoot: { visibleClaimBans: ['best consultancy', 'best consultant'] } } };

describe('findVisibleClaimIssues', () => {
  test('flags a banned phrase in visible body copy, with a correction', () => {
    const { issues } = findVisibleClaimIssues({ title: 'Study in the UK', sections: [{ heading: 'Why us', body: 'We are the Best  Consultancy for you.' }] }, 'blog-outline', site);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'sections[0].body');
    assert.match(issues[0].correction, /best consultancy/);
  });
  test('allows the phrase in meta title, meta description and schema fields', () => {
    const content = { title: 'Study in the UK', metaTitle: 'Best Consultancy for UK study', metaDescription: 'The best consultancy in Nepal', schema: { name: 'best consultancy' }, sections: [{ heading: 'a', body: 'Plain factual copy.' }] };
    assert.deepEqual(findVisibleClaimIssues(content, 'landing-page', site).issues, []);
  });
  test('search-only generators are exempt entirely', () => {
    assert.deepEqual(findVisibleClaimIssues({ titles: ['Best consultancy'], metaDescription: 'best consultancy' }, 'meta-title', site).issues, []);
  });
  test('word boundaries: does not match inside another word', () => {
    assert.deepEqual(findVisibleClaimIssues({ body: 'the best consultancyfoo' }, 'faq', site).issues, []);
  });
  test('a site with no ban list is unaffected', () => {
    assert.deepEqual(findVisibleClaimIssues({ body: 'best consultancy' }, 'faq', { url_file_map: { siteRoot: {} } }).issues, []);
    assert.deepEqual(findVisibleClaimIssues({ body: 'best consultancy' }, 'faq', null).issues, []);
  });
});

import { searchClaimsFor, visibleClaimBansExemptGeneratorsFor, titleClaimBansFor, findBannedPhrases } from './visible-claim-guard.js';
describe('searchClaimsFor', () => {
  test('reads the per-site list and tolerates a missing one', () => {
    assert.deepEqual(searchClaimsFor({ url_file_map: { siteRoot: { searchClaims: ['best consultancy', ' '] } } }), ['best consultancy']);
    assert.deepEqual(searchClaimsFor(null), []);
  });
});

describe('per-site generator exemption (blog may use the word, landing pages may not)', () => {
  const s2 = { url_file_map: { siteRoot: { visibleClaimBans: ['consultancy'], visibleClaimBansExemptGenerators: ['blog-outline'] } } };
  test('a blog generator is exempt, every other generator is still checked', () => {
    assert.deepEqual(findVisibleClaimIssues({ body: 'A study abroad consultancy guide.' }, 'blog-outline', s2).issues, []);
    assert.equal(findVisibleClaimIssues({ body: 'A study abroad consultancy guide.' }, 'landing-page', s2).issues.length, 1);
    assert.equal(findVisibleClaimIssues({ body: 'A study abroad consultancy guide.' }, 'expand-content', s2).issues.length, 1);
  });
  test('without the exemption list the blog generator is checked too', () => {
    const s3 = { url_file_map: { siteRoot: { visibleClaimBans: ['consultancy'] } } };
    assert.equal(findVisibleClaimIssues({ body: 'A consultancy guide.' }, 'blog-outline', s3).issues.length, 1);
  });
  test('reads the list and tolerates a missing one', () => {
    assert.deepEqual(visibleClaimBansExemptGeneratorsFor(s2), ['blog-outline']);
    assert.deepEqual(visibleClaimBansExemptGeneratorsFor(null), []);
  });
});

describe('titleClaimBansFor / findBannedPhrases', () => {
  test('reads the per-site list and matches whole words only, case-insensitively', () => {
    const site = { url_file_map: { siteRoot: { titleClaimBans: ['consultancy', ' '] } } };
    assert.deepEqual(titleClaimBansFor(site), ['consultancy']);
    assert.deepEqual(titleClaimBansFor(null), []);
    assert.deepEqual(findBannedPhrases('Study Abroad Consultancy in Nepal', ['consultancy']), ['consultancy']);
    assert.deepEqual(findBannedPhrases('Study abroad partner', ['consultancy']), []);
    assert.deepEqual(findBannedPhrases('consultancyfoo', ['consultancy']), []);
  });
});
