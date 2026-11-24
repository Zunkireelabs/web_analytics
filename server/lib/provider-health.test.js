import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { providerFailureCount, lastProviderFailure, noteProviderFailure, _resetProviderHealthForTest } from './provider-health.js';
import { isProviderFault } from '../generators/lib/llm-error.js';

beforeEach(() => _resetProviderHealthForTest());

describe('provider health counter', () => {
  test('only ever goes up, and remembers the last reason', () => {
    assert.equal(providerFailureCount(), 0);
    noteProviderFailure(new Error('Your credit balance is too low to access the Anthropic API'));
    noteProviderFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    assert.equal(providerFailureCount(), 2);
    assert.equal(lastProviderFailure().lastMessage, 'x');
  });
});

describe('what counts as the AI provider failing (and what does not)', () => {
  const yes = [
    Object.assign(new Error('429 Your project has reached its configured enforced spend limit.'), { status: 429 }),
    Object.assign(new Error('400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 }),
    Object.assign(new Error('boom'), { status: 503 }),
    Object.assign(new Error('x'), { code: 'ECONNRESET' }),
    Object.assign(new Error('Incorrect API key provided'), { status: 401 }),
  ];
  const no = [
    Object.assign(new Error('Model did not return valid JSON after 2 attempts.'), { status: 400 }),
    new Error('expected an array of titles'),
    undefined,
  ];
  for (const e of yes) test(`provider fault: ${String(e.message).slice(0, 50)}`, () => assert.equal(isProviderFault(e), true));
  for (const e of no) test(`not a provider fault: ${String(e?.message).slice(0, 50)}`, () => assert.equal(isProviderFault(e), false));
});
