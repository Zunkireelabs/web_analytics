import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildComplianceDesignDriftFindings, trackerCheckIsActionable } from './trust-compliance.js';

const TRACKER_FACTS = { siteName: 'Acme', domain: 'acme.example', cookiesObserved: [], trackersDetected: [] };
const RESOLVED_PAGES = [
  { check: { key: 'privacy-policy', label: 'Privacy Policy' }, href: 'https://acme.example/privacy/' },
  { check: { key: 'terms-of-service', label: 'Terms of Service' }, href: 'https://acme.example/terms/' },
];

describe('buildComplianceDesignDriftFindings', () => {
  test('an already-verified wrapper means no drift findings at all — never invents a defect', () => {
    const findings = buildComplianceDesignDriftFindings(RESOLVED_PAGES, { ok: true }, TRACKER_FACTS, 'https://acme.example/');
    assert.deepEqual(findings, []);
  });

  test('no resolved pages means no findings, even with an unverified wrapper', () => {
    const findings = buildComplianceDesignDriftFindings([], { ok: false, reason: 'missing' }, TRACKER_FACTS, 'https://acme.example/');
    assert.deepEqual(findings, []);
  });

  test('an unverified wrapper flags every resolved compliance page, one finding each', () => {
    const findings = buildComplianceDesignDriftFindings(RESOLVED_PAGES, { ok: false, reason: 'missing' }, TRACKER_FACTS, 'https://acme.example/');
    assert.equal(findings.length, 2);
    assert.equal(findings[0].id, 'trust-compliance:privacy-policy:design-drift');
    assert.equal(findings[0].recommendedAction.generatorId, 'privacy-policy');
    assert.equal(findings[0].recommendedAction.params.page, 'https://acme.example/privacy/');
    assert.equal(findings[0].recommendedAction.params.siteName, 'Acme');
    assert.match(findings[0].whyItMatters, /not derived yet/);
  });

  test('an unreviewed-but-existing wrapper (reason "unreviewed"/"stale") still gets flagged, with a different reason phrased', () => {
    const findings = buildComplianceDesignDriftFindings(RESOLVED_PAGES, { ok: false, reason: 'stale' }, TRACKER_FACTS, 'https://acme.example/');
    assert.match(findings[0].whyItMatters, /not yet verified against the live site/);
  });

  test('regenerating routes through the existing safe-tier compliance generator, not a new one', () => {
    const findings = buildComplianceDesignDriftFindings(RESOLVED_PAGES, { ok: false, reason: 'missing' }, TRACKER_FACTS, 'https://acme.example/');
    assert.deepEqual(findings.map((f) => f.recommendedAction.generatorId), ['privacy-policy', 'terms-of-service']);
  });
});

// A missing-tracker finding is only worth filing if the fix can actually be
// completed. analytics-install needs the site's own tracking ID; with none it
// emits a placeholder, the draft refuses at the placeholder gate, and the
// recommendation reopens next run — forever. Meta/Facebook Pixel had no
// column to store an ID at all, which made
// `trust-compliance:facebook-pixel:missing` site 1's worst repeat offender at
// 15 failed attempts, each costing a generation call to reach the same
// refusal.
describe('trackerCheckIsActionable', () => {
  test('a tracker with a real ID is filed as before', () => {
    assert.equal(trackerCheckIsActionable({ label: 'GA4', trackingId: 'G-2ZQRDS0D14' }), true);
  });

  test('a tracker with no stored ID is not filed — the draft could never be completed', () => {
    assert.equal(trackerCheckIsActionable({ label: 'Meta/Facebook Pixel', trackingId: null }), false);
    assert.equal(trackerCheckIsActionable({ label: 'x', trackingId: '' }), false);
    assert.equal(trackerCheckIsActionable({ label: 'x', trackingId: '   ' }), false);
    assert.equal(trackerCheckIsActionable({ label: 'x' }), false);
  });

  // Keyed on the ID, not the provider, so the day a facebook_pixel_id column
  // exists the check starts firing again with no code change here.
  test('the rule is about the ID, not about which provider it is', () => {
    assert.equal(trackerCheckIsActionable({ label: 'Meta/Facebook Pixel', trackingId: '1234567890' }), true);
  });
});
