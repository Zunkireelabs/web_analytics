import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT, classifyLinkProbe, isAssertable, makeVerification } from './verdict.js';

describe('classifyLinkProbe', () => {
  test('a 404 or 410 is confirmed dead', () => {
    assert.equal(classifyLinkProbe({ finalStatus: 404, error: null }).verdict, VERDICT.CONFIRMED);
    assert.equal(classifyLinkProbe({ finalStatus: 410, error: null }).verdict, VERDICT.CONFIRMED);
  });

  // The shared-footer-link case: failing with no HTTP status on both attempts
  // is a transient outage, not proof — asserting it flags every page carrying
  // the link.
  test('a network error or timeout with no status is unverifiable, never confirmed', () => {
    assert.equal(classifyLinkProbe({ finalStatus: null, error: 'network error' }).verdict, VERDICT.UNVERIFIABLE);
    assert.equal(classifyLinkProbe({ finalStatus: null, error: 'timeout' }).verdict, VERDICT.UNVERIFIABLE);
  });

  test('403/429/5xx are access or transient states, not proof the page is gone', () => {
    for (const finalStatus of [401, 403, 429, 500, 502, 503, 504]) {
      assert.equal(classifyLinkProbe({ finalStatus, error: null }).verdict, VERDICT.UNVERIFIABLE, String(finalStatus));
    }
  });

  test('bot-protection flag from the retry wrapper stays unverifiable', () => {
    assert.equal(classifyLinkProbe({ finalStatus: 403, unverifiable: true }).verdict, VERDICT.UNVERIFIABLE);
  });

  test('a soft-404 fingerprint match is confirmed; a clean 200 is refuted', () => {
    assert.equal(classifyLinkProbe({ finalStatus: 200, error: null, softNotFound: true }).verdict, VERDICT.CONFIRMED);
    assert.equal(classifyLinkProbe({ finalStatus: 200, error: null }).verdict, VERDICT.REFUTED);
  });

  test('an invalid URL is a real defect', () => {
    assert.equal(classifyLinkProbe({ finalStatus: null, error: 'invalid URL' }).verdict, VERDICT.CONFIRMED);
  });
});

describe('isAssertable', () => {
  test('only confirmed, or a legacy finding with no verification, may be asserted', () => {
    assert.equal(isAssertable({}), true);
    assert.equal(isAssertable({ verification: null }), true);
    assert.equal(isAssertable({ verification: makeVerification(VERDICT.CONFIRMED, 'x') }), true);
    assert.equal(isAssertable({ verification: makeVerification(VERDICT.REFUTED, 'x') }), false);
    assert.equal(isAssertable({ verification: makeVerification(VERDICT.UNVERIFIABLE, 'x') }), false);
  });

  test('rejects an unknown verdict at construction', () => {
    assert.throws(() => makeVerification('probably', 'x'));
  });
});

import { requiresHumanReview } from './risk-tiers.js';
describe('requiresHumanReview', () => {
  test('geo-signals checklist findings and typography-drift fixes are never auto-eligible', () => {
    assert.equal(requiresHumanReview({ source: 'geo-signals', params: {} }), true);
    assert.equal(requiresHumanReview({ source: 'design-consistency', params: { fixType: 'typography-drift-scoped' } }), true);
  });
  test('other findings keep their generator tier', () => {
    assert.equal(requiresHumanReview({ source: 'technical-seo', params: {} }), false);
    assert.equal(requiresHumanReview({ source: 'design-consistency', params: { fixType: 'font-size-override' } }), false);
    assert.equal(requiresHumanReview(undefined), false);
  });
});

import { runAsDryRun, isDryRun } from './dry-run-context.js';
describe('dry-run context', () => {
  test('is off by default and on only inside runAsDryRun, including across awaits', async () => {
    assert.equal(isDryRun(), false);
    await runAsDryRun(async () => { await Promise.resolve(); assert.equal(isDryRun(), true); });
    assert.equal(isDryRun(), false);
  });
});
