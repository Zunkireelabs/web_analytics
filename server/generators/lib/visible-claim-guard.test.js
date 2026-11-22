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

describe('article-page exemption (decided from the page, for every generator)', () => {
  const on = { url_file_map: { siteRoot: { visibleClaimBans: ['consultancy'], visibleClaimBansExemptArticlePages: true } } };
  const off = { url_file_map: { siteRoot: { visibleClaimBans: ['consultancy'] } } };
  const body = { body: 'A study abroad consultancy guide.' };
  test('an article page is exempt for ANY generator when the site opts in', () => {
    for (const g of ['expand-content', 'faq', 'landing-page']) {
      assert.deepEqual(findVisibleClaimIssues(body, g, on, { isArticlePage: true }).issues, []);
    }
  });
  test('a non-article page is still checked', () => {
    assert.equal(findVisibleClaimIssues(body, 'expand-content', on, { isArticlePage: false }).issues.length, 1);
    assert.equal(findVisibleClaimIssues(body, 'expand-content', on).issues.length, 1);
  });
  test('a site that has not opted in is unaffected, even on an article page', () => {
    assert.equal(findVisibleClaimIssues(body, 'expand-content', off, { isArticlePage: true }).issues.length, 1);
  });
});

import { findNeverSayIssues } from './visible-claim-guard.js';

describe('neverSayPhrases (general pages only; blog and Nepal pages exempt)', () => {
  const nsSite = { url_file_map: { siteRoot: { neverSayPhrases: ['study abroad partner in Nepal'], neverSayExemptUrlContains: ['nepal'] } } };
  const bad = { body: 'Your study abroad partner in Nepal' };
  test('flags the phrase (and the hyphen form) on a general page, incl. title fields', () => {
    assert.equal(findNeverSayIssues(bad, nsSite, { pageUrl: 'https://x.com/' }).issues.length, 1);
    assert.equal(findNeverSayIssues({ metaTitle: 'Study-abroad partner in Nepal | Admizz' }, nsSite, { pageUrl: 'https://x.com/' }).issues.length, 1);
    assert.equal(findNeverSayIssues(bad, nsSite).issues.length, 1); // unknown page = strict
  });
  test('allows it on blog posts and Nepal URLs', () => {
    assert.equal(findNeverSayIssues(bad, nsSite, { isArticlePage: true, pageUrl: 'https://x.com/ielts' }).issues.length, 0);
    assert.equal(findNeverSayIssues(bad, nsSite, { pageUrl: 'https://x.com/study-abroad-from-nepal' }).issues.length, 0);
  });
  test('ignores `previous` (the page\'s current text being replaced)', () => {
    assert.equal(findNeverSayIssues({ previous: { title: 'Admizz: Study Abroad Partner in Nepal' }, titles: ['Admizz Education: Study Abroad Partner'] }, nsSite, { pageUrl: 'https://x.com/' }).issues.length, 0);
    assert.equal(findNeverSayIssues({ previous: { title: 'x' }, titles: ['Study Abroad Partner in Nepal'] }, nsSite, { pageUrl: 'https://x.com/' }).issues.length, 1);
  });
  test('allows each part alone, and sites without the list', () => {
    assert.equal(findNeverSayIssues({ body: 'A trusted study abroad partner. Offices across Nepal.' }, nsSite, { pageUrl: 'https://x.com/' }).issues.length, 0);
    assert.equal(findNeverSayIssues(bad, {}).issues.length, 0);
  });
});
