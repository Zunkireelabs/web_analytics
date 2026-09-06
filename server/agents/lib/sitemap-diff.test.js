import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintSet, computeMissingUrls, buildMissingUrlsFinding } from './sitemap-diff.js';

// Pure logic only — no DB/HTTP involved, so every case here runs without a
// real database. The DB-fetching wrapper (agents/sitemap.js's run()) is
// covered by manual/sandbox verification instead, same convention as
// generators/html-lang.test.js's documented DB-path exclusion.

describe('fingerprintSet', () => {
  test('is stable regardless of input order', () => {
    const a = fingerprintSet(['/page-a/', '/page-b/', '/page-c/']);
    const b = fingerprintSet(['/page-c/', '/page-a/', '/page-b/']);
    assert.equal(a, b);
  });

  test('changes when the set changes', () => {
    const a = fingerprintSet(['/page-a/', '/page-b/']);
    const b = fingerprintSet(['/page-a/', '/page-b/', '/page-c/']);
    assert.notEqual(a, b);
  });

  test('ignores duplicate entries', () => {
    const a = fingerprintSet(['/page-a/', '/page-b/']);
    const b = fingerprintSet(['/page-a/', '/page-a/', '/page-b/']);
    assert.equal(a, b);
  });
});

describe('computeMissingUrls', () => {
  test('returns nothing when every known page is already in the sitemap', () => {
    const inventory = ['/a/', '/b/'];
    const sitemap = [{ loc: '/a/' }, { loc: '/b/' }];
    assert.deepEqual(computeMissingUrls(inventory, sitemap), []);
  });

  test('finds a single missing URL', () => {
    const inventory = ['/a/', '/b/'];
    const sitemap = [{ loc: '/a/' }];
    assert.deepEqual(computeMissingUrls(inventory, sitemap), ['/b/']);
  });

  test('finds multiple missing URLs, sorted', () => {
    const inventory = ['/c/', '/a/', '/b/'];
    const sitemap = [];
    assert.deepEqual(computeMissingUrls(inventory, sitemap), ['/a/', '/b/', '/c/']);
  });

  test('never proposes removing an existing sitemap entry not in inventory (additive-only diff direction)', () => {
    const inventory = ['/a/'];
    const sitemap = [{ loc: '/a/' }, { loc: '/old-page/' }];
    // Only ever reports pages missing FROM the sitemap — '/old-page/' being
    // absent from inventory must never appear in this result.
    assert.deepEqual(computeMissingUrls(inventory, sitemap), []);
  });

  test('a trailing-slash difference between inventory and sitemap is not reported as missing', () => {
    const inventory = ['https://example.com/about'];
    const sitemap = [{ loc: 'https://example.com/about/' }];
    assert.deepEqual(computeMissingUrls(inventory, sitemap), []);
  });

  test('an http/https difference between inventory and sitemap is not reported as missing', () => {
    const inventory = ['http://example.com/about/'];
    const sitemap = [{ loc: 'https://example.com/about/' }];
    assert.deepEqual(computeMissingUrls(inventory, sitemap), []);
  });

  test('a real different page is still correctly reported as missing (normalization is not over-broad)', () => {
    const inventory = ['https://example.com/about/', 'https://example.com/pricing/'];
    const sitemap = [{ loc: 'https://example.com/about' }];
    assert.deepEqual(computeMissingUrls(inventory, sitemap), ['https://example.com/pricing/']);
  });

  test('two sites with overlapping page sets never leak into each other (tenant isolation)', () => {
    const siteAInventory = ['/tenant-a/page-1/', '/tenant-a/page-2/'];
    const siteASitemap = [{ loc: '/tenant-a/page-1/' }];
    const siteBInventory = ['/tenant-b/page-1/'];
    const siteBSitemap = [];

    const missingA = computeMissingUrls(siteAInventory, siteASitemap);
    const missingB = computeMissingUrls(siteBInventory, siteBSitemap);

    assert.deepEqual(missingA, ['/tenant-a/page-2/']);
    assert.deepEqual(missingB, ['/tenant-b/page-1/']);
    assert.ok(!missingA.some((u) => u.includes('tenant-b')));
    assert.ok(!missingB.some((u) => u.includes('tenant-a')));
  });
});

describe('buildMissingUrlsFinding', () => {
  test('returns null when nothing is missing — no Action Center noise', () => {
    const finding = buildMissingUrlsFinding({ sitemapPath: 'public/sitemap.xml', missingUrls: [], orphanedUrls: [] });
    assert.equal(finding, null);
  });

  test('multiple missing URLs still produce exactly ONE finding', () => {
    const finding = buildMissingUrlsFinding({
      sitemapPath: 'public/sitemap.xml',
      missingUrls: ['/a/', '/b/', '/c/'],
      orphanedUrls: [],
    });
    assert.ok(finding);
    assert.equal(finding.evidence.missingCount, 3);
    assert.match(finding.whyItMatters, /3 discovered URLs are missing/);
  });

  test('finding id embeds the fingerprint of the missing-URL set', () => {
    const finding = buildMissingUrlsFinding({ sitemapPath: 'x', missingUrls: ['/a/', '/b/'], orphanedUrls: [] });
    assert.equal(finding.id, `sitemap:site:missing-urls:${fingerprintSet(['/a/', '/b/'])}`);
  });

  test('same missing-URL set (different discovery order) produces the same finding id — no duplicate draft', () => {
    const f1 = buildMissingUrlsFinding({ sitemapPath: 'x', missingUrls: ['/a/', '/b/', '/c/'], orphanedUrls: [] });
    const f2 = buildMissingUrlsFinding({ sitemapPath: 'x', missingUrls: ['/c/', '/b/', '/a/'], orphanedUrls: [] });
    assert.equal(f1.id, f2.id);
  });

  test('a genuinely new missing URL changes the finding id', () => {
    const f1 = buildMissingUrlsFinding({ sitemapPath: 'x', missingUrls: ['/a/', '/b/'], orphanedUrls: [] });
    const f2 = buildMissingUrlsFinding({ sitemapPath: 'x', missingUrls: ['/a/', '/b/', '/c/'], orphanedUrls: [] });
    assert.notEqual(f1.id, f2.id);
  });

  test('orphaned URLs are surfaced as evidence/narrative, never as a removal action', () => {
    const finding = buildMissingUrlsFinding({
      sitemapPath: 'x', missingUrls: ['/new/'], orphanedUrls: ['/old-page/'],
    });
    assert.deepEqual(finding.evidence.orphanedUrls, ['/old-page/']);
    assert.match(finding.whyItMatters, /not removed automatically/);
    // recommendedAction only ever points at the additive sitemap generator —
    // never a delete/removal action type.
    assert.equal(finding.recommendedAction.generatorId, 'sitemap');
  });

  test('recommendedAction carries exactly the missing URLs, so the generator never has to re-derive them', () => {
    const finding = buildMissingUrlsFinding({ sitemapPath: 'x', missingUrls: ['/a/'], orphanedUrls: [] });
    assert.deepEqual(finding.recommendedAction.params.missingUrls, ['/a/']);
  });
});
