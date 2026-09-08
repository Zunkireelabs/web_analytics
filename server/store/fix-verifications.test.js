import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isVerifiableDraft } from './fix-verifications.js';

// Prompt 7 audit, section 9: draft.source gets overwritten with the
// shipping-mechanism label ('auto-remediation'/'execution-engine') by any
// autonomous path, which used to make isVerifiableDraft() return false for
// a fix that DOES have a real tag-based recheck available — not because
// the fix is unverifiable, but because the column that carried "which
// detecting agent found this" got repurposed. finding_origin (migration
// 119) is the fix: the real detecting agent, preserved separately and
// checked here in preference to `source`.
function draft(overrides = {}) {
  return {
    source: 'opportunity', finding_origin: null, finding_id: 'x', action_type: 'meta-title',
    input: { page: 'https://x.com/p' },
    ...overrides,
  };
}

describe('isVerifiableDraft — finding_origin vs source', () => {
  test('a manual draft with no finding_origin falls back to source, unchanged from before', () => {
    assert.equal(isVerifiableDraft(draft({ source: 'opportunity', finding_origin: null })), true);
    assert.equal(isVerifiableDraft(draft({ source: 'content-gap', finding_origin: null })), true);
  });

  test('a draft whose source was overwritten by the shipping mechanism regains verifiability via finding_origin', () => {
    const d = draft({ source: 'auto-remediation', finding_origin: 'opportunity' });
    assert.equal(isVerifiableDraft(d), true, 'the real detecting agent (finding_origin) is what should decide this, not the shipping-mechanism label');
  });

  test('an execution-engine-shipped content-gap fix is also recovered', () => {
    const d = draft({ source: 'execution-engine', finding_origin: 'content-gap' });
    assert.equal(isVerifiableDraft(d), true);
  });

  test('an Analyst-originated draft stays correctly non-verifiable — no tag-based recheck exists for a numeric-decline finding', () => {
    const d = draft({ source: 'auto-remediation', finding_origin: 'analyst-insights' });
    assert.equal(isVerifiableDraft(d), false, 'analyst-insights is a real origin but not one currentTagsFor knows how to re-derive tags for');
  });

  test('a draft with neither a verifiable source nor a verifiable finding_origin stays unverifiable', () => {
    assert.equal(isVerifiableDraft(draft({ source: 'learned-repair', finding_origin: null })), false);
  });

  test('still requires finding_id, a verifiable generator, and a page regardless of origin', () => {
    assert.equal(isVerifiableDraft(draft({ finding_origin: 'opportunity', finding_id: null })), false);
    assert.equal(isVerifiableDraft(draft({ finding_origin: 'opportunity', action_type: 'expand-content' })), false);
    assert.equal(isVerifiableDraft(draft({ finding_origin: 'opportunity', input: {} })), false);
  });
});

// analytics-install (trust-compliance.js) is verified by a different
// mechanism (a literal tracking-ID presence check, not a tag re-derivation —
// see agents/lib/fix-verification.js's verifyAnalyticsInstall), but reuses
// this same eligibility gate.
function analyticsDraft(overrides = {}) {
  return {
    source: 'auto-remediation', finding_origin: 'trust-compliance', finding_id: 'trust-compliance:analytics:missing',
    action_type: 'analytics-install',
    input: { page: 'https://x.com/', provider: 'ga4', trackingId: 'G-ABC123' },
    content: { trackingId: 'G-ABC123', placeholderFields: [] },
    ...overrides,
  };
}

describe('isVerifiableDraft — analytics-install (tracking-ID verification)', () => {
  test('a real, non-placeholder analytics-install draft is verifiable', () => {
    assert.equal(isVerifiableDraft(analyticsDraft()), true);
  });

  test('a placeholder draft (no real ID yet) is never scheduled — nothing to verify', () => {
    const d = analyticsDraft({ content: { trackingId: '[NEEDS INPUT — not verifiable from real site data]', placeholderFields: ['trackingId'] } });
    assert.equal(isVerifiableDraft(d), false);
  });

  test('an analytics-install draft from a non-trust-compliance origin is not verifiable', () => {
    assert.equal(isVerifiableDraft(analyticsDraft({ finding_origin: null, source: 'action-center' })), false);
  });

  test('still requires finding_id, page, and a real input trackingId', () => {
    assert.equal(isVerifiableDraft(analyticsDraft({ finding_id: null })), false);
    assert.equal(isVerifiableDraft(analyticsDraft({ input: { page: 'https://x.com/' } })), false);
    assert.equal(isVerifiableDraft(analyticsDraft({ input: { trackingId: 'G-ABC123' } })), false);
  });
});
