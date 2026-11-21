import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInspectError } from './gsc-technical.js';

describe('classifyInspectError', () => {
  const kind = (err) => classifyInspectError(err).errorKind;
  test('names the cause so "could not be inspected" stops hiding it', () => {
    assert.equal(kind({ code: 429 }), 'quota');
    assert.equal(kind({ message: 'RESOURCE_EXHAUSTED: Quota exceeded' }), 'quota');
    assert.equal(kind({ code: 401 }), 'auth');
    assert.equal(kind({ message: 'invalid_grant' }), 'auth');
    assert.equal(kind({ code: 403 }), 'permission');
    assert.equal(kind({ code: 404 }), 'property-not-found');
    assert.equal(kind({ code: 400 }), 'bad-request');
    assert.equal(kind({ code: 503 }), 'google-unavailable');
    assert.equal(kind({ code: 'ETIMEDOUT' }), 'network');
    assert.equal(kind(new Error('something else')), 'other');
    assert.equal(kind(null), 'other');
  });
  test('keeps the HTTP status when there is one, and never returns message text', () => {
    assert.equal(classifyInspectError({ code: 403, message: 'User does not own property sc-domain:secret-client.com' }).httpStatus, 403);
    assert.deepEqual(Object.keys(classifyInspectError({ code: 403, message: 'sc-domain:secret-client.com' })).sort(), ['errorKind', 'httpStatus']);
    assert.equal(classifyInspectError({ code: 'ETIMEDOUT' }).httpStatus, null);
  });
});
