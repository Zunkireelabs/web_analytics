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

import { verificationMethodFor as vmf, VERIFICATION_METHOD as VM } from './fix-verifications.js';
describe('verificationMethodFor — the three generators whose old needle was the wrong thing', () => {
  test('internal-links verifies the links, not the rationale sentence', () => {
    const plan = vmf({ action_type: 'internal-links', input: { page: 'https://s.test/a/' }, content: { page: 'https://s.test/a/', suggestions: [{ anchorText: 'study in the UK', targetUrl: 'https://s.test/uk/', rationale: 'This strengthens topical authority across the site.' }] } }, { siteOrigin: 'https://s.test' });
    assert.equal(plan.method, VM.LINKS_PRESENT);
    assert.deepEqual(plan.expected.links, [{ href: 'https://s.test/uk/', anchor: 'study in the UK' }]);
    assert.equal(JSON.stringify(plan).includes('topical authority'), false, 'the rationale must never become a required match');
  });
  test('internal-links with no suggestions is unverifiable with a reason, not a vacuous pass', () => {
    const plan = vmf({ action_type: 'internal-links', input: { page: 'https://s.test/a/' }, content: { page: 'x', suggestions: [] } });
    assert.equal(plan.method, VM.UNVERIFIABLE);
  });
  test('schema-repair verifies the schema state, not a JSON slice', () => {
    const dup = vmf({ action_type: 'schema-repair', input: { page: 'https://s.test/a/' }, content: { fixType: 'remove-duplicate', duplicateType: 'LocalBusiness', originalRaw: '{"@type":"LocalBusiness"}' } });
    assert.equal(dup.method, VM.SCHEMA_STATE);
    assert.equal(dup.expected.duplicateType, 'LocalBusiness');
    const fix = vmf({ action_type: 'schema-repair', input: { page: 'https://s.test/a/' }, content: { fixType: 'repair-malformed', jsonLd: { '@type': 'Organization' } } });
    assert.equal(fix.expected.fixType, 'repair-malformed');
  });
  test('meta-title verifies the chosen title AND the description', () => {
    const plan = vmf({ action_type: 'meta-title', input: { page: 'https://s.test/a/' }, content: { titles: ['T1', 'T2'], selectedTitle: 'T2', metaDescription: 'A description long enough to matter here.' } });
    assert.equal(plan.method, VM.META_TAGS);
    assert.deepEqual(plan.expected, { title: 'T2', description: 'A description long enough to matter here.' });
  });
});

import { checkContentAgainstExpectation as check } from '../agents/lib/fix-verification.js';
describe('pre-approval check, end to end: plan from the draft, matched against the file the draft will write', () => {
  const run = (draft, file) => { const p = vmf(draft, { siteOrigin: 'https://s.test' }); return check(p.method, p.expected, file, p.target); };
  test('a correct internal-links draft passes (it used to be abandoned because its rationale is not in the file)', () => {
    const draft = { action_type: 'internal-links', input: { page: 'https://s.test/a/' }, content: { suggestions: [{ anchorText: 'study in the UK', targetUrl: 'https://s.test/uk/', rationale: 'Builds topical authority.' }] } };
    assert.equal(run(draft, '<p>Read how to <a href="/uk/">study in the UK</a>.</p>').present, true);
    assert.equal(run(draft, '<p>Read how to study in the UK.</p>').present, false, 'but a draft that did not add the link still fails');
  });
  test('a correct meta-title draft passes despite entity/escape differences, and fails when the description is not written', () => {
    const draft = { action_type: 'meta-title', input: { page: 'https://s.test/a/' }, content: { selectedTitle: 'Costs & Visas | S', metaDescription: "Everything you need — it's simple and clear." } };
    assert.equal(run(draft, `title: 'Costs & Visas | S', description: 'Everything you need — it\\'s simple and clear.'`).present, true);
    assert.equal(run(draft, `title: 'Costs & Visas | S', description: 'old text'`).present, false);
  });
  test('a correct schema duplicate removal passes on the file it produces', () => {
    const draft = { action_type: 'schema-repair', input: { page: 'https://s.test/a/' }, content: { fixType: 'remove-duplicate', duplicateType: 'Thing', originalRaw: '{"@type":"Thing","a":2}' } };
    assert.equal(run(draft, '<script type="application/ld+json">{"@type":"Thing","a":1}</script>').present, true);
    assert.equal(run(draft, '<script type="application/ld+json">{"@type":"Thing","a":1}</script><script type="application/ld+json">{"@type":"Thing","a":2}</script>').present, false);
  });
});
