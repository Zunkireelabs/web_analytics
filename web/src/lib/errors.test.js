import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorMessage } from './errors.js';

describe('safeErrorMessage', () => {
  test('blocks the exact leaked pattern from the Google CSE incident', () => {
    const raw = 'Citation search failed: Google Custom Search request failed: HTTP 403 — This project does not have the access to Custom Search JSON API.';
    assert.equal(safeErrorMessage(raw), 'Something went wrong — please try again.');
  });

  test('blocks HTTP status patterns', () => {
    assert.equal(safeErrorMessage('createBranch failed (403): Resource not accessible'), 'Something went wrong — please try again.');
  });

  test('blocks raw network exception names', () => {
    assert.equal(safeErrorMessage('fetch failed: ECONNREFUSED 127.0.0.1:443'), 'Something went wrong — please try again.');
  });

  test('leaves genuine, safe server-authored text untouched', () => {
    const safe = 'Draft not found, or not submitted for approval';
    assert.equal(safeErrorMessage(safe), safe);
  });

  test('uses a custom fallback when given one', () => {
    assert.equal(safeErrorMessage('HTTP 500', 'Custom fallback.'), 'Custom fallback.');
  });

  test('falls back on empty/non-string input', () => {
    assert.equal(safeErrorMessage(undefined), 'Something went wrong — please try again.');
    assert.equal(safeErrorMessage(''), 'Something went wrong — please try again.');
    assert.equal(safeErrorMessage(null), 'Something went wrong — please try again.');
  });
});
