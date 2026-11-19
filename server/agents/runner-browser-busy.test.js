import test from 'node:test';
import assert from 'node:assert/strict';
import { isBrowserBusyError } from './runner.js';
import { BrowserCapacityError } from '../lib/browser-slots.js';

// The real error, as thrown by lib/browser-slots.js when all slots stay busy (seen in prod 2026-11-19 for visual-quality).
test('a browser-capacity error is recognised by its code and by its name', () => {
  const real = new BrowserCapacityError('All 3 browser slots are busy across workers; try again shortly.');
  assert.equal(isBrowserBusyError(real), true);
  assert.equal(isBrowserBusyError(Object.assign(new Error('x'), { code: 'BROWSER_CAPACITY' })), true);
});

test('any other failure is still an error: nothing else is downgraded', () => {
  assert.equal(isBrowserBusyError(new Error('rows is not defined')), false);
  assert.equal(isBrowserBusyError(Object.assign(new Error('429 enforced spend limit'), { status: 429 })), false);
  assert.equal(isBrowserBusyError(null), false);
});
