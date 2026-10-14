import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { providerCoverageCaveat } from './provider-coverage.js';

describe('providerCoverageCaveat', () => {
  test('no caveat when every known provider is configured', () => {
    assert.equal(providerCoverageCaveat([{ id: 'openai', configured: true }, { id: 'anthropic', configured: true }]), null);
  });

  test('no caveat with a single fully-configured provider (default deployment)', () => {
    assert.equal(providerCoverageCaveat([{ id: 'openai', configured: true }]), null);
  });

  test('surfaces a caveat naming the real count when some providers are not connected', () => {
    const caveat = providerCoverageCaveat([
      { id: 'openai', configured: true },
      { id: 'anthropic', configured: false },
      { id: 'gemini', configured: false },
    ]);
    assert.equal(caveat.configuredCount, 1);
    assert.equal(caveat.totalCount, 3);
    assert.match(caveat.text, /1 of 3 AI providers/);
  });

  test('singular wording for a single-provider deployment that is not configured', () => {
    const caveat = providerCoverageCaveat([{ id: 'openai', configured: false }]);
    assert.match(caveat.text, /0 of 1 AI provider —/);
  });

  test('null/empty/undefined input is never a caveat', () => {
    assert.equal(providerCoverageCaveat(null), null);
    assert.equal(providerCoverageCaveat(undefined), null);
    assert.equal(providerCoverageCaveat([]), null);
  });
});
