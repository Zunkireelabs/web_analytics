import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  weeklyBuckets, googlePage, isUnrelatedQuery, isUnrelatedPage, matchingSearches, previousSiteShare,
  checkTag, compareChecks, extractJsonLd, businessDetails, describeListing, checkListing, countSitemapUrls, buildHeadline,
} from './progress-helpers.js';

describe('weeklyBuckets', () => {
  const rows = [
    { date: '2026-08-20', clicks: 1, impressions: 3 }, { date: '2026-08-21', clicks: 0, impressions: 5 },   // Thu, Fri
    { date: '2026-08-24', clicks: 0, impressions: 4 }, { date: '2026-08-30', clicks: 0, impressions: 2 },   // Mon, Sun
    { date: '2026-08-31', clicks: 2, impressions: 9 },                                                      // next Mon
  ];
  test('groups by Monday-start week, partial weeks included, totals preserved', () => {
    const w = weeklyBuckets(rows);
    assert.deepEqual(w.map((x) => x.label), ['Aug 17', 'Aug 24', 'Aug 31']);
    assert.deepEqual(w.map((x) => x.impressions), [8, 6, 9]);
    assert.equal(w.reduce((a, x) => a + x.impressions, 0), rows.reduce((a, r) => a + r.impressions, 0));
    assert.equal(w.reduce((a, x) => a + x.clicks, 0), 3);
  });
  test('empty input gives no weeks', () => assert.deepEqual(weeklyBuckets([]), []));
});

describe('googlePage', () => {
  test('positions 1-10 are page 1, 78.5 is page 8', () => {
    assert.equal(googlePage(1), 1); assert.equal(googlePage(10), 1);
    assert.equal(googlePage(10.4), 2); assert.equal(googlePage(78.5), 8); assert.equal(googlePage(0), 1);
  });
});

describe('unrelated detection', () => {
  test('flags gambling and non-Latin searches but not business searches', () => {
    for (const q of ['best online casino uk', 'uk roulette', 'كازينو اون لاين']) assert.equal(isUnrelatedQuery(q), true, q);
    for (const q of ['residential removals kettering', 'moving house storage', 'senior relocation', 'storage northampton']) assert.equal(isUnrelatedQuery(q), false, q);
  });
  test('flags leftover page URLs but keeps normal pages, including WordPress ?p= ids', () => {
    for (const u of ['https://s.com/best-gambling-website-uk/', 'https://s.com/shop/storeSearch/KeepCriteriaInput.aspx?x=1', 'https://s.com/?h=8020347041280']) assert.equal(isUnrelatedPage(u), true, u);
    for (const u of ['https://s.com/', 'https://s.com/senior-movers-kettering/', 'https://s.com/?p=9224']) assert.equal(isUnrelatedPage(u), false, u);
  });
});

describe('matchingSearches', () => {
  test('drops unrelated searches, sorts by appearances, caps, and gives the Google page', () => {
    const out = matchingSearches([
      { query: 'casino uk', impressions: 50, position: 3 },
      { query: 'senior relocation', impressions: 6, position: 85 },
      { query: 'residential removals kettering', impressions: 12, position: 78.5 },
      { query: 'moving house storage', impressions: 6, position: 5.17 },
    ], { max: 2 });
    assert.deepEqual(out, [
      { query: 'residential removals kettering', impressions: 12, page: 8 },
      { query: 'senior relocation', impressions: 6, page: 9 },
    ]);
  });
});

describe('previousSiteShare', () => {
  test('reports a large leftover share as "about N in 10" and the unrelated search counts', () => {
    const r = previousSiteShare({
      pageRows: [{ page: 'https://s.com/', impressions: 60 }, { page: 'https://s.com/casino-x/', impressions: 40 }],
      queryRows: [{ query: 'casino', impressions: 48 }, { query: 'senior relocation', impressions: 39 }],
    });
    assert.equal(r.pagesInTen, 4);
    assert.equal(r.unrelatedSearches, 48);
    assert.equal(r.totalSearches, 87);
  });
  test('a clean site returns null so the box never shows', () => {
    assert.equal(previousSiteShare({ pageRows: [{ page: 'https://s.com/', impressions: 100 }], queryRows: [{ query: 'removals', impressions: 50 }] }), null);
    assert.equal(previousSiteShare({}), null);
  });
});

describe('compareChecks', () => {
  test('tags by the final score first, then by improvement', () => {
    assert.equal(checkTag(0, 25), 'NEEDS MORE WORK');
    assert.equal(checkTag(60, 88), 'IMPROVED');
    assert.equal(checkTag(60, 61), 'STEADY');
    assert.equal(checkTag(100, 98), 'STEADY');
  });
  test('joins baseline names to live keys, in the standard order, and only says what we did when real work exists', () => {
    const rows = compareChecks(
      [{ category: 'Schema markup', score: 0 }, { category: 'FAQ coverage', score: 60 }, { category: 'Entity markup', score: 0 }],
      { schema: 100, faq: 88, entities: 25, geoSignals: 67 },
      { faq: 3 },
    );
    assert.deepEqual(rows.map((r) => r.name), ['Page labels', 'Questions and answers', 'Business facts']);
    assert.equal(rows[0].did, null);
    assert.equal(rows[1].did, 'We added question-and-answer sections to 3 pages.');
    assert.equal(rows[2].tag, 'NEEDS MORE WORK');
  });
  test('a check missing from either side is left out, never invented', () => {
    assert.deepEqual(compareChecks([{ category: 'FAQ coverage', score: 10 }], {}), []);
  });
});

describe('website details and listings', () => {
  const html = `<html><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'MovingCompany', name: 'Chayce Properties Ltd', telephone: '+447708925432',
    address: { '@type': 'PostalAddress', streetAddress: 'Unit F2B Barratt House, Kingsthorpe Road', addressLocality: 'Northampton', postalCode: 'NN2 6EZ' },
    sameAs: ['https://www.yell.com/biz/x/', 'https://www.trustpilot.com/review/chayceproperties.com', 'https://example.org/p'],
  })}</script><script type="application/ld+json">{ broken json</script></html>`;
  test('reads the business and its sameAs links, ignoring a malformed block', () => {
    const d = businessDetails(extractJsonLd(html));
    assert.equal(d.name, 'Chayce Properties Ltd');
    assert.equal(d.address, 'Unit F2B Barratt House, Kingsthorpe Road, Northampton, NN2 6EZ');
    assert.equal(d.sameAs.length, 3);
  });
  test('names known listing sites in plain words and falls back to the host', () => {
    assert.equal(describeListing('https://www.yell.com/biz/x/').name, 'Yell');
    assert.equal(describeListing('https://share.google/abc').name, 'Google Business Profile');
    assert.equal(describeListing('https://www.example.org/p').name, 'example.org');
  });
  test('LIVE only when the page opens and shows the business; blocked or error pages are LISTED', async () => {
    const l = describeListing('https://www.brownbook.net/business/1/x');
    const ok = async () => ({ ok: true, text: async () => '<title>Chayce Properties Ltd Kingsthorpe Road</title>' });
    const blocked = async () => ({ ok: false, status: 403, text: async () => '' });
    const wrongPage = async () => ({ ok: true, text: async () => '<title>Some other business</title>' });
    const boom = async () => { throw new Error('network'); };
    assert.equal((await checkListing(l, 'Chayce Properties Ltd', ok)).status, 'live');
    assert.equal((await checkListing(l, 'Chayce Properties Ltd', blocked)).status, 'listed');
    assert.equal((await checkListing(l, 'Chayce Properties Ltd', wrongPage)).status, 'listed');
    assert.equal((await checkListing(l, 'Chayce Properties Ltd', boom)).status, 'listed');
  });
});

describe('countSitemapUrls', () => {
  test('counts pages, following one level of sitemap index', async () => {
    const pages = '<urlset><url><loc>https://s.com/a</loc></url><url><loc>https://s.com/b</loc></url></urlset>';
    const index = '<sitemapindex><sitemap><loc>https://s.com/p1.xml</loc></sitemap><sitemap><loc>https://s.com/p2.xml</loc></sitemap></sitemapindex>';
    const f = async (u) => ({ ok: true, text: async () => (u.endsWith('sitemap.xml') ? index : pages) });
    assert.equal(await countSitemapUrls('https://s.com/sitemap.xml', f), 4);
    assert.equal(await countSitemapUrls('https://s.com/p1.xml', f), 2);
  });
  test('throws when the sitemap cannot be read', async () => {
    await assert.rejects(() => countSitemapUrls('https://s.com/sitemap.xml', async () => ({ ok: false, status: 404 })));
  });
});

describe('buildHeadline', () => {
  test('mentions growth only when pages really grew', () => {
    assert.match(buildHeadline({ ai: { base: 39, now: 77 }, pages: { base: 19, now: 104 } }).grew, /104 pages/);
    assert.equal(buildHeadline({ ai: { base: 39, now: 77 }, pages: { base: 50, now: 50 } }).grew, '');
    assert.match(buildHeadline({ ai: null, pages: null }).lead, /Here is where your website stands/);
  });
});
