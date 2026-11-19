import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProbeRequest } from './anthropic.js';

describe('anthropic buildProbeRequest', () => {
  test('no country: no system prompt, exactly the old request', () => {
    const body = buildProbeRequest('best removals company for elderly parents');
    assert.equal(body.system, undefined);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'best removals company for elderly parents' }]);
    assert.equal(body.max_tokens, 600);
  });

  test('a UK client is asked as a user in the United Kingdom', () => {
    const body = buildProbeRequest('q', { country: { iso: 'GB', name: 'the United Kingdom' } });
    assert.equal(body.system, 'The user is located in the United Kingdom.');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'q' }]);
  });
});
