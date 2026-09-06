import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { filterSoftNotFoundPages, clearSoftNotFoundCache, zeroTrafficSlotsFor } from './candidate-pages.js';

// A 200 status does not prove a page exists. zunkireelabs.com serves its
// homepage byte-for-byte for ANY unmatched path — /gaas/ and /zzz-not-a-page/
// both return 200 with the homepage — so sitemap/crawl discovery fed phantom
// URLs into page_inventory and every page-level agent analyzed them. The
// resulting recommendations could never be fixed: /gaas/ failed 9 times.
//
// Both collaborators are injected, so none of this touches the network.
const FINGERPRINT = { status: 200, text: 'nothing here' };
const fingerprintOk = async () => FINGERPRINT;

// Treats any URL in `phantoms` as rendering the catch-all response.
const softNotFoundIn = (phantoms) => async (url) => phantoms.includes(url);

const REAL = 'https://acme.example/real-page/';
const PHANTOM = 'https://acme.example/gaas/';

describe('filterSoftNotFoundPages', () => {
  beforeEach(() => clearSoftNotFoundCache());

  test('drops a phantom page and keeps the real ones', async () => {
    const { pages, dropped } = await filterSoftNotFoundPages(1, [REAL, PHANTOM], {
      fetchFingerprint: fingerprintOk,
      checkSoftNotFound: softNotFoundIn([PHANTOM]),
    });

    assert.deepEqual(pages, [REAL]);
    assert.deepEqual(dropped, [PHANTOM], 'dropped is returned, not just logged, so a caller can report it honestly');
  });

  test('a site with no catch-all loses nothing', async () => {
    const { pages, dropped } = await filterSoftNotFoundPages(1, [REAL, PHANTOM], {
      fetchFingerprint: fingerprintOk,
      checkSoftNotFound: async () => false,
    });

    assert.deepEqual(pages, [REAL, PHANTOM]);
    assert.deepEqual(dropped, []);
  });

  // Additive by design: this must never be the reason a real page goes
  // unanalyzed. A failed fingerprint fetch (network, private host) disables it.
  test('no fingerprint means no filtering at all', async () => {
    const { pages, dropped } = await filterSoftNotFoundPages(1, [REAL, PHANTOM], {
      fetchFingerprint: async () => null,
      checkSoftNotFound: async () => true, // would drop everything if consulted
    });

    assert.deepEqual(pages, [REAL, PHANTOM]);
    assert.deepEqual(dropped, []);
  });

  // The guardrail that matters most. A fully client-rendered site legitimately
  // serves one shell for every route, real or not — there the fingerprint
  // matches everything, and filtering would delete the site's entire page list.
  test('a suspiciously high match rate disables the filter instead of emptying the batch', async () => {
    const many = Array.from({ length: 8 }, (_, i) => `https://acme.example/p${i}/`);
    const { pages, dropped } = await filterSoftNotFoundPages(1, many, {
      fetchFingerprint: fingerprintOk,
      checkSoftNotFound: async () => true,
    });

    assert.deepEqual(pages, many, 'trust the pages, not the heuristic');
    assert.deepEqual(dropped, []);
  });

  // Below the minimum sample the ratio is meaningless — two of three matching
  // is ordinary on a small batch and must still filter.
  test('the bailout needs a real sample before it fires', async () => {
    const three = ['https://acme.example/a/', 'https://acme.example/b/', 'https://acme.example/c/'];
    const { pages } = await filterSoftNotFoundPages(1, three, {
      fetchFingerprint: fingerprintOk,
      checkSoftNotFound: softNotFoundIn(three.slice(0, 2)),
    });

    assert.deepEqual(pages, [three[2]]);
  });

  // ~12 page-level agents call this per cron pass. Without caching, the filter
  // would cost more requests than the phantom pages it saves.
  test('the fingerprint and per-URL verdicts are fetched once per site, not once per agent', async () => {
    let fingerprintCalls = 0;
    let urlChecks = 0;
    const opts = {
      fetchFingerprint: async () => { fingerprintCalls++; return FINGERPRINT; },
      checkSoftNotFound: async (url) => { urlChecks++; return url === PHANTOM; },
    };

    await filterSoftNotFoundPages(1, [REAL, PHANTOM], opts);
    await filterSoftNotFoundPages(1, [REAL, PHANTOM], opts);
    await filterSoftNotFoundPages(1, [REAL, PHANTOM], opts);

    assert.equal(fingerprintCalls, 1, 'one fingerprint per site per window');
    assert.equal(urlChecks, 2, 'each URL judged once, then reused');
  });

  test('an empty or unparseable batch is returned untouched, never throwing', async () => {
    const empty = await filterSoftNotFoundPages(1, [], { fetchFingerprint: fingerprintOk });
    assert.deepEqual(empty.pages, []);

    const junk = await filterSoftNotFoundPages(1, ['not-a-url'], {
      fetchFingerprint: fingerprintOk,
      checkSoftNotFound: async () => true,
    });
    assert.deepEqual(junk.pages, ['not-a-url'], 'no origin to fingerprint against — filter cannot apply');
  });
});

describe('zeroTrafficSlotsFor — the whole site gets scanned, not just its top pages', () => {
  // The reported symptom: newer blog posts and low-traffic resource pages
  // never getting an FAQ, because they never reached the front of the queue.
  test('a lopsided site gives zero-traffic pages far more than the old fixed quarter', () => {
    // 40 GSC pages vs 200 zero-traffic: the old fixed 0.25 gave 5 slots.
    assert.equal(zeroTrafficSlotsFor(20, 40, 200), 12);
  });

  test('the proportional share is capped, so GSC-known pages keep a real share', () => {
    // Even at 1000-vs-5, quota-limited GSC work keeps 40% of the batch.
    assert.equal(zeroTrafficSlotsFor(20, 5, 1000), 12);
  });

  test('a balanced site is unchanged from the original behaviour', () => {
    // proportional == 0.5 here, above the 0.25 floor and below the cap.
    assert.equal(zeroTrafficSlotsFor(20, 100, 100), 10);
  });

  test('the original quarter still applies as a floor when GSC pages dominate', () => {
    assert.equal(zeroTrafficSlotsFor(20, 200, 10), 5);
  });

  test('no zero-traffic pages reserves nothing — the batch is all GSC', () => {
    assert.equal(zeroTrafficSlotsFor(20, 50, 0), 0);
  });

  test('a brand-new site with no GSC data at all spends the whole batch on inventory', () => {
    assert.equal(zeroTrafficSlotsFor(20, 0, 50), 20);
  });
});
