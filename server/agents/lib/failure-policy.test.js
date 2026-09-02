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
