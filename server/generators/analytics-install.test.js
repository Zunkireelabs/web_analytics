import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// getSiteById is mocked so every test controls exactly what "the site's
// configured tracking ID" is, without touching a real database — same
// convention as blog-image.test.js/faq.test.js for this same store module.
let siteFixture;
let siteLookupThrows = null;
mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async (id) => {
      if (siteLookupThrows) throw siteLookupThrows;
      assert.equal(id, siteFixture?.id ?? id);
      return siteFixture;
    },
  },
});

const { generate, meta, verifyCurrentState } = await import('./analytics-install.js');

beforeEach(() => { siteFixture = null; siteLookupThrows = null; });

describe('analytics-install generator', () => {
  test('meta.id matches the generatorId trust-compliance.js wires into recommendedAction', () => {
    assert.equal(meta.id, 'analytics-install');
  });

  test('rejects an unknown provider', async () => {
    await assert.rejects(() => generate({ params: { provider: 'tiktok-pixel' } }));
  });

  // 2026-11-22: no placeholder draft any more. Missing input is reported as missing input (needs_input), once, instead of a draft
  // that is refused at the publish gate and retried every day.
  test('refuses with needs-input (never a placeholder script) when no real tracking ID exists anywhere', async () => {
    await assert.rejects(
      () => generate({ params: { provider: 'ga4', page: 'https://example.com/' } }),
      (err) => err.needsInput === true && err.refusal === true && err.reason === 'ga4-id-missing' && /Needs input/.test(err.message),
    );
  });

  test('GA4: a property ID alone is NOT a measurement ID — discovery is tried, and a miss says exactly what is missing', async () => {
    siteFixture = { id: 1, ga4_property_id: '561094281', ga4_measurement_id: null };
    let asked = 0;
    const ensureMeasurementId = async () => { asked++; return { status: 'no-web-stream' }; };
    await assert.rejects(
      () => generate({ siteId: 1, params: { provider: 'ga4' }, deps: { ensureMeasurementId } }),
      (err) => err.needsInput === true && /no web data stream/i.test(err.message),
    );
    assert.equal(asked, 1);
  });

  test('GA4: a measurement ID discovered from the connected property is used', async () => {
    siteFixture = { id: 1, ga4_property_id: '561094281', ga4_measurement_id: null };
    const ensureMeasurementId = async () => ({ status: 'found', measurementId: 'G-DISCOVER01', saved: true });
    const { content } = await generate({ siteId: 1, params: { provider: 'ga4' }, deps: { ensureMeasurementId } });
    assert.match(content.script, /G-DISCOVER01/);
    assert.equal(content.idSource, 'discovered-from-ga4-stream');
  });

  test('GA4: a temporary lookup failure is a retryable refusal, not a client request', async () => {
    siteFixture = { id: 1, ga4_property_id: '561094281', ga4_measurement_id: null };
    const ensureMeasurementId = async () => ({ status: 'unavailable' });
    await assert.rejects(
      () => generate({ siteId: 1, params: { provider: 'ga4' }, deps: { ensureMeasurementId } }),
      (err) => err.needsInput === false && err.temporary === true && err.reason === 'ga4-lookup-unavailable',
    );
  });

  test('a stored measurement ID is used without any discovery call', async () => {
    siteFixture = { id: 1, ga4_property_id: '1', ga4_measurement_id: 'G-STORED0001' };
    const ensureMeasurementId = async () => { throw new Error('must not be called'); };
    const { content } = await generate({ siteId: 1, params: { provider: 'ga4' }, deps: { ensureMeasurementId } });
    assert.match(content.script, /G-STORED0001/);
    assert.equal(content.idSource, 'site-config');
  });

  test('drafts a real GA4 script when a valid measurement ID is given via params', async () => {
    const { content, summary } = await generate({ params: { provider: 'ga4', trackingId: 'G-ABC1234XYZ' } });
    assert.deepEqual(content.placeholderFields, []);
    assert.match(content.script, /G-ABC1234XYZ/);
    assert.doesNotMatch(summary, /needs real tracking ID/);
  });

  test('drafts a real Facebook Pixel script when a valid numeric ID is given via params', async () => {
    const { content } = await generate({ params: { provider: 'facebook-pixel', trackingId: '123456789012345' } });
    assert.deepEqual(content.placeholderFields, []);
    assert.match(content.script, /123456789012345/);
    assert.match(content.script, /fbevents\.js/);
  });

  test('refuses when the given ID does not match the provider\'s real ID shape', async () => {
    await assert.rejects(() => generate({ params: { provider: 'ga4', trackingId: 'not-a-real-id' } }), (err) => err.needsInput === true);
  });

  // ── The bug this file was written to catch: a stale recommendation's
  // frozen params carry no trackingId, but the site's OWN CONFIGURATION
  // already has one. Confirmed live on site 1: drafts #631/#632
  // (2026-08-31, params with no trackingId) failed 15 times with the
  // "unverified placeholder field" refusal while sites.ga4_measurement_id
  // and sites.facebook_pixel_id both already held valid IDs. ──
  describe('reading the site\'s own configured ID (2026-09-08 fix)', () => {
    test('a configured GA4 ID is used even when params carry none at all — the stale-recommendation case', async () => {
      siteFixture = { id: 1, ga4_measurement_id: 'G-2ZQRDS0D14', facebook_pixel_id: null };
      const { content, summary } = await generate({ siteId: 1, params: { provider: 'ga4', page: 'https://zunkireelabs.com/' } });
      assert.deepEqual(content.placeholderFields, [], 'the generator must NOT report this as missing');
      assert.match(content.script, /G-2ZQRDS0D14/, 'the generator must receive and use the real configured ID');
      assert.doesNotMatch(summary, /needs real tracking ID/);
      assert.doesNotMatch(content.script, /NEEDS INPUT/);
    });

    test('a configured Facebook Pixel ID is used the same way', async () => {
      siteFixture = { id: 1, ga4_measurement_id: null, facebook_pixel_id: '2104437347081359' };
      const { content } = await generate({ siteId: 1, params: { provider: 'facebook-pixel', page: 'https://zunkireelabs.com/' } });
      assert.deepEqual(content.placeholderFields, []);
      assert.match(content.script, /2104437347081359/);
    });

    test('the configured site ID wins over a stale/different value carried in params', async () => {
      siteFixture = { id: 1, ga4_measurement_id: 'G-CURRENTVALID', facebook_pixel_id: null };
      const { content } = await generate({ siteId: 1, params: { provider: 'ga4', trackingId: 'G-STALEFROZEN' } });
      assert.match(content.script, /G-CURRENTVALID/);
      assert.doesNotMatch(content.script, /G-STALEFROZEN/);
    });

    test('a malformed value stored on the site is never used (shape is validated, not just presence)', async () => {
      siteFixture = { id: 1, ga4_measurement_id: 'not-a-real-id', facebook_pixel_id: null };
      const ensureMeasurementId = async () => ({ status: 'ambiguous' });
      await assert.rejects(() => generate({ siteId: 1, params: { provider: 'ga4' }, deps: { ensureMeasurementId } }), (err) => err.needsInput === true);
    });

    test('a site lookup failure falls back to whatever params carry, never a hard error', async () => {
      siteLookupThrows = new Error('db unreachable');
      const { content } = await generate({ siteId: 1, params: { provider: 'ga4', trackingId: 'G-FROMPARAMS1' } });
      assert.match(content.script, /G-FROMPARAMS1/);
    });

    test('no siteId at all (a direct caller with only params) behaves exactly as before', async () => {
      const { content } = await generate({ params: { provider: 'ga4', trackingId: 'G-DIRECTCALL1' } });
      assert.match(content.script, /G-DIRECTCALL1/);
    });
  });
});

describe('analytics-install verifyCurrentState — never a duplicate tag', () => {
  const rec = (provider = 'ga4') => ({ params: { provider, page: 'https://s.test/' } });
  const html = (body) => async () => ({ ok: true, html: `<html><head>${body}</head></html>` });
  test('GA4 already on the page -> already_resolved, with evidence, nothing to generate', async () => {
    const r = await verifyCurrentState(rec(), { fetchHtml: html('<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234XYZ"></script>') });
    assert.equal(r.decision, 'already_resolved');
    assert.equal(r.evidence.tracker, 'Google Analytics (GA4)');
  });
  test('a tag manager container -> needs_human (a direct tag could double-count)', async () => {
    const r = await verifyCurrentState(rec(), { fetchHtml: html('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD123"></script>') });
    assert.equal(r.decision, 'needs_human');
    assert.match(r.evidence.message, /double-count/);
  });
  test('nothing installed -> still valid', async () => {
    assert.equal((await verifyCurrentState(rec(), { fetchHtml: html('') })).decision, 'still_valid');
  });
  test('an unreadable page is never treated as installed or absent', async () => {
    assert.equal((await verifyCurrentState(rec(), { fetchHtml: async () => ({ ok: false, error: 'timeout' }) })).reason, 'live-check-failed');
    assert.equal((await verifyCurrentState(rec(), { fetchHtml: async () => { throw new Error('boom'); } })).decision, 'still_valid');
  });
  test('the Pixel check looks for the Pixel, not GA4', async () => {
    const r = await verifyCurrentState(rec('facebook-pixel'), { fetchHtml: html('<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234XYZ"></script>') });
    assert.equal(r.decision, 'still_valid');
  });
});

describe('analytics-install verifyCurrentState — the repository is read too (no duplicate, no blind install)', () => {
  const site = { id: 8871, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', pr_target_branch: null, ga4_measurement_id: 'G-7V8PXXZF3G', ga4_property_id: '1' };
  const rec = { params: { provider: 'ga4', page: 'https://s.test/' } };
  const noTagHtml = async () => ({ ok: true, html: '<html><head></head></html>' });
  const scan = (hits) => async () => ({ ok: true, refs: [{ ref: 'main', hits }] });
  const run = (over) => verifyCurrentState(rec, { site, fetchHtml: noTagHtml, ...over });

  test('the project\'s own ID already in the repo (consent-gated loader the live HTML cannot show) -> already_resolved', async () => {
    const r = await run({ scanRepo: scan([{ path: 'src/scripts/cookie-consent.js', ga4: ['G-7V8PXXZF3G'], gtm: [], gtag: true }]) });
    assert.equal(r.decision, 'already_resolved');
    assert.equal(r.reason, 'ga4-already-in-repo');
  });
  test('a DIFFERENT ID, or a GTM container, in the repo -> needs_human, never a second tag', async () => {
    const other = await run({ scanRepo: scan([{ path: 'a.njk', ga4: ['G-OTHER00001'], gtm: [], gtag: true }]) });
    assert.equal(other.decision, 'needs_human');
    assert.equal(other.reason, 'other-tracking-in-repo');
    const gtm = await run({ scanRepo: scan([{ path: 'b.html', ga4: [], gtm: ['GTM-ABCD123'], gtag: false }]) });
    assert.equal(gtm.decision, 'needs_human');
  });
  test('an unreadable repo -> needs_human, never "nothing installed"', async () => {
    const r = await run({ scanRepo: async () => ({ ok: false, error: 'the repository could not be read at main' }) });
    assert.equal(r.decision, 'needs_human');
    assert.equal(r.reason, 'repo-unreadable');
  });
  test('clean live page AND clean repo -> the install is still valid', async () => {
    const r = await run({ scanRepo: scan([]) });
    assert.equal(r.decision, 'still_valid');
    assert.equal(r.reason, 'tracker-absent-on-live-page-and-in-repo');
  });
  test('with no stored ID the project\'s own stream ID is looked up (read-only) to recognise its own tag', async () => {
    const r = await run({ site: { ...site, ga4_measurement_id: null }, discover: async () => ({ status: 'found', measurementId: 'G-6LYQRZY03B' }), scanRepo: scan([{ path: 'base.njk', ga4: ['G-6LYQRZY03B'], gtm: [], gtag: true }]) });
    assert.equal(r.decision, 'already_resolved');
  });
});
