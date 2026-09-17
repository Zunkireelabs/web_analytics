import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let hasBrokenLinkFix;
mock.module(resolve('../registry.js'), {
  namedExports: {
    getGenerator: async (id) => {
      if (id !== 'broken-link-fix') return null;
      return hasBrokenLinkFix
        ? { meta: { id: 'broken-link-fix' }, generate: async () => ({}), verifyCurrentState: hasBrokenLinkFix }
        : { meta: { id: 'broken-link-fix' }, generate: async () => ({}) };
    },
  },
});

const { verifyRecommendation, isAlreadyResolved, VERIFICATION_DECISION } = await import('./verification-layer.js');

describe('verifyRecommendation', () => {
  test('a generator with no verifyCurrentState keeps today\'s behavior exactly: still_valid, no evidence', async () => {
    hasBrokenLinkFix = null;
    const result = await verifyRecommendation({ recommendation_type: 'broken-link-fix' }, {});
    assert.deepEqual(result, { decision: 'still_valid', reason: 'no-verifier-available', evidence: null });
  });

  test('an unknown recommendation_type is treated the same as no verifier', async () => {
    const result = await verifyRecommendation({ recommendation_type: 'nonexistent-generator' }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-verifier-available');
  });

  test('passes through a generator\'s valid decision verbatim', async () => {
    hasBrokenLinkFix = async () => ({ decision: 'already_resolved', reason: 'confirmed-absent', evidence: { x: 1 } });
    const result = await verifyRecommendation({ recommendation_type: 'broken-link-fix' }, { site: {} });
    assert.deepEqual(result, { decision: 'already_resolved', reason: 'confirmed-absent', evidence: { x: 1 } });
  });

  test('a generator throwing is not evidence about the recommendation — falls back to still_valid', async () => {
    hasBrokenLinkFix = async () => { throw new Error('GitHub rate limit reached'); };
    const result = await verifyRecommendation({ recommendation_type: 'broken-link-fix' }, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'verification-error');
    assert.match(result.evidence.error, /rate limit/);
  });

  test('a generator returning an invalid decision is treated as an error, not trusted verbatim', async () => {
    hasBrokenLinkFix = async () => ({ decision: 'definitely-fixed-trust-me' });
    const result = await verifyRecommendation({ recommendation_type: 'broken-link-fix' }, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'verification-error');
  });
});

describe('isAlreadyResolved', () => {
  test('true only for the already_resolved decision', () => {
    assert.equal(isAlreadyResolved({ decision: VERIFICATION_DECISION.ALREADY_RESOLVED }), true);
    assert.equal(isAlreadyResolved({ decision: VERIFICATION_DECISION.STILL_VALID }), false);
    assert.equal(isAlreadyResolved(null), false);
  });
});
