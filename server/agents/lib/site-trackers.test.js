import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectTrackersInHtml, trackerAbsenceIsProvable } from './site-trackers.js';

// Regression coverage for the GTM-blind analytics check. The signatures here
// read STATIC HTML only, and originally matched nothing but a direct
// `gtag/js?id=G-` / `fbq('init'` snippet. Any tenant deploying GA4 or the
// Meta Pixel through Google Tag Manager — the dominant install pattern on
// WordPress/Shopify/agency sites, and the first thing the second tenant
// brought with it — was therefore reported as having no analytics at all,
// and offered an analytics-install draft for a tag that was already live.
// A second GA4 tag double-counts every pageview, so acting on that finding
// corrupts the tenant's own numbers.

describe('detectTrackersInHtml', () => {
  test('detects a GTM container from the script snippet', () => {
    const html = '<script>(function(w,d,s,l,i){})(window,document,"script","dataLayer","GTM-ABC1234");</script>'
      + '<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234"></script>';
    const { trackersDetected, tagManagersDetected } = detectTrackersInHtml(html);
    assert.deepEqual(tagManagersDetected, ['Google Tag Manager']);
    assert.ok(trackersDetected.includes('Google Tag Manager'));
  });

  test('detects a GTM container installed as only the noscript iframe', () => {
    const html = '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XYZ9876"></iframe></noscript>';
    assert.deepEqual(detectTrackersInHtml(html).tagManagersDetected, ['Google Tag Manager']);
  });

  test('detects the consolidated Google tag (GT-) container', () => {
    const html = '<script src="https://www.googletagmanager.com/gtag/js?id=GT-ABCDEFG"></script>';
    assert.deepEqual(detectTrackersInHtml(html).tagManagersDetected, ['Google Tag Manager']);
  });

  test('a GTM container is never mistaken for GA4 itself — it only proves a container', () => {
    const html = '<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234"></script>';
    const { trackersDetected } = detectTrackersInHtml(html);
    assert.equal(trackersDetected.includes('Google Analytics (GA4)'), false);
    assert.equal(trackersDetected.includes('Meta/Facebook Pixel'), false);
  });

  test('a direct GA4 install is still detected as GA4, and is not a tag manager', () => {
    const html = '<script src="https://www.googletagmanager.com/gtag/js?id=G-1234567"></script>';
    const { trackersDetected, tagManagersDetected } = detectTrackersInHtml(html);
    assert.ok(trackersDetected.includes('Google Analytics (GA4)'));
    assert.deepEqual(tagManagersDetected, []);
  });

  test('a page with no tracking at all detects nothing', () => {
    assert.deepEqual(detectTrackersInHtml('<html><body>hello</body></html>'), {
      trackersDetected: [], tagManagersDetected: [],
    });
  });
});

describe('trackerAbsenceIsProvable', () => {
  test('false when a tag manager is present — its tags load at runtime, invisible to static HTML', () => {
    assert.equal(trackerAbsenceIsProvable({ trackerAbsenceProvable: false, tagManagersDetected: ['Google Tag Manager'] }), false);
  });

  test('true only on a page that was really fetched and carries no container', () => {
    assert.equal(trackerAbsenceIsProvable({ trackerAbsenceProvable: true, tagManagersDetected: [] }), true);
  });

  test('fails closed for a facts object that predates the field, or a failed fetch', () => {
    // Silence is the safe direction: no page was read, so nothing was ruled out.
    assert.equal(trackerAbsenceIsProvable({ trackersDetected: [] }), false);
    assert.equal(trackerAbsenceIsProvable(null), false);
  });
});
