import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildComplianceDesignDriftFindings } from './trust-compliance.js';

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

// DESIGN NOTE (not independently unit-testable here): a missing-tracker
// finding (TRACKER_CHECKS inside run(), no exported seam of its own) is filed
// REGARDLESS of whether a trackingId is known — the draft ships with a
// placeholder blocking auto-publish until a human fills in the real ID by
// hand-editing it in the Action Center. An earlier version of this file
// suppressed filing entirely once a tracker had no stored ID
// (trackerCheckIsActionable, since removed), on the reasoning that an
// unattended draft could never complete it — correct about the unattended
// loop, wrong about the fix: it also hid the finding from the ONE place a
// human could ever discover and fix it, since nothing in this app writes
// ga4_measurement_id or facebook_pixel_id automatically (confirmed: no route
// or script in this repo sets either column). The unattended-loop problem
// (facebook-pixel:missing had 15 wasted auto-remediation attempts) now
// belongs at ship-pacing.js's convergence cap instead, which holds a finding
// after repeated identical failures while leaving it open and visible for a
// human — see store/drafts.test.js and auto-remediation.test.js's
// 'unverified placeholder field'/UNVERIFIED_PLACEHOLDER_FRAGMENT coverage.
