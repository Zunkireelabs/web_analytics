import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyShipFailure, failureFamilyKey, FAILURE_KIND } from './failure-policy.js';

describe('classifyShipFailure', () => {
  test('a rate-limited error is classified RATE_LIMIT before anything else', () => {
    const err = Object.assign(new Error('GitHub rate limit reached'), { rateLimited: true });
    assert.equal(classifyShipFailure(err).kind, FAILURE_KIND.RATE_LIMIT);
  });

  test('a refusal is always ITEM, even if its text mentions infrastructure-sounding words', () => {
    const err = new Error('cannot reach the repository right now — try again');
    assert.equal(classifyShipFailure(err, { isRefusal: true }).kind, FAILURE_KIND.ITEM);
  });

  test('dead GitHub credentials (401, not rate-limited) are SYSTEMIC', () => {
    const err = Object.assign(new Error('Bad credentials'), { status: 401 });
    assert.equal(classifyShipFailure(err).kind, FAILURE_KIND.SYSTEMIC);
  });

  test('a "Bad credentials" message signature is SYSTEMIC even without a status code', () => {
    const err = new Error('Bad credentials');
    assert.equal(classifyShipFailure(err).kind, FAILURE_KIND.SYSTEMIC);
  });

  test('a database-unavailable error code is SYSTEMIC', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    assert.equal(classifyShipFailure(err).kind, FAILURE_KIND.SYSTEMIC);
  });

  test('repository-not-found is SYSTEMIC — no later item on this site can reach it either', () => {
    const err = new Error('Repository not found');
    assert.equal(classifyShipFailure(err).kind, FAILURE_KIND.SYSTEMIC);
  });

  test('an ordinary generator error (malformed content, missing config entry) is ITEM', () => {
    const err = new Error('"pokhara" has no "services.aeo-seo" entry in src/_data/locations.js');
    assert.equal(classifyShipFailure(err).kind, FAILURE_KIND.ITEM);
  });

  test('a generic, unrecognized error is ITEM, never assumed systemic by default', () => {
    assert.equal(classifyShipFailure(new Error('something went wrong')).kind, FAILURE_KIND.ITEM);
  });
});

describe('failureFamilyKey', () => {
  test('two errors that differ only by page-specific detail collapse into the same family', () => {
    const a = failureFamilyKey('expand-content', new Error('"pokhara" has no "services.aeo-seo" entry in src/_data/locations.js — this page has no unique content'));
    const b = failureFamilyKey('expand-content', new Error('"lalitpur" has no "services.ai-development" entry in src/_data/locations.js — this page has no unique content'));
    assert.equal(a, b, `expected the same family, got:\n  ${a}\n  ${b}`);
  });

  test('different generators never share a family, even with identical message text', () => {
    const a = failureFamilyKey('expand-content', new Error('same message'));
    const b = failureFamilyKey('qa-content', new Error('same message'));
    assert.notEqual(a, b);
  });

  test('genuinely different failure shapes on the same generator produce different families', () => {
    const a = failureFamilyKey('expand-content', new Error('no sections to expand'));
    const b = failureFamilyKey('expand-content', new Error('upstream GitHub API returned 503'));
    assert.notEqual(a, b);
  });
});

import { classifyRefusal, REFUSAL_KIND, countsAgainstGenerator, refusalReasonOf, refusalFamilyKey, UNSPECIFIED_REFUSAL } from './failure-policy.js';

describe('refusal classification', () => {
  test('each kind is recognised', () => {
    assert.equal(classifyRefusal({ needsInput: true }), REFUSAL_KIND.NEEDS_INPUT);
    assert.equal(classifyRefusal({ reason: 'no-file-mapping' }), REFUSAL_KIND.NEEDS_INPUT);
    assert.equal(classifyRefusal({ reason: 'ga4-id-missing' }), REFUSAL_KIND.NEEDS_INPUT);
    assert.equal(classifyRefusal({ stale: true }), REFUSAL_KIND.STALE);
    assert.equal(classifyRefusal({ alreadyResolved: true }), REFUSAL_KIND.ALREADY_RESOLVED);
    assert.equal(classifyRefusal({ designPending: true }), REFUSAL_KIND.DESIGN_VALIDATION_PENDING);
    assert.equal(classifyRefusal({ temporary: true }), REFUSAL_KIND.TEMPORARY_EXTERNAL);
    assert.equal(classifyRefusal({ reason: 'awaiting-human-review' }), REFUSAL_KIND.HUMAN_APPROVAL_REQUIRED);
    assert.equal(classifyRefusal({ unsupported: true }), REFUSAL_KIND.UNSUPPORTED);
    assert.equal(classifyRefusal({ reason: 'design-integrity-failed' }), REFUSAL_KIND.GENERATOR_DEFECT);
    assert.equal(classifyRefusal({}), REFUSAL_KIND.GENERATOR_DEFECT, 'a refusal nobody explained is treated as a defect, never as success');
  });
  test('only real generator signals count against a generator', () => {
    for (const k of [REFUSAL_KIND.NEEDS_INPUT, REFUSAL_KIND.STALE, REFUSAL_KIND.ALREADY_RESOLVED, REFUSAL_KIND.TEMPORARY_EXTERNAL, REFUSAL_KIND.DESIGN_VALIDATION_PENDING, REFUSAL_KIND.HUMAN_APPROVAL_REQUIRED]) assert.equal(countsAgainstGenerator(k), false, k);
    assert.equal(countsAgainstGenerator(REFUSAL_KIND.GENERATOR_DEFECT), true);
    assert.equal(countsAgainstGenerator(REFUSAL_KIND.UNSUPPORTED), true);
  });
  test('an empty reason is labelled, never blank, and stays attributable to its generator', () => {
    assert.equal(refusalReasonOf({}), UNSPECIFIED_REFUSAL);
    assert.match(refusalReasonOf({ message: 'something odd' }), /^unspecified-refusal: something odd/);
    assert.notEqual(refusalFamilyKey('schema-repair', {}), refusalFamilyKey('faq', {}));
  });
  test('same generator + same reason share one family, different reasons do not', () => {
    assert.equal(refusalFamilyKey('schema', { reason: 'a' }), refusalFamilyKey('schema', { reason: 'a' }));
    assert.notEqual(refusalFamilyKey('schema', { reason: 'a' }), refusalFamilyKey('schema', { reason: 'b' }));
  });
});
