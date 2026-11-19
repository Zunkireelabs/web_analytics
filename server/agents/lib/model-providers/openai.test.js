import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProbeRequest } from './openai.js';

describe('buildProbeRequest', () => {
  test('no country: the request is exactly the old one (prompt only, no location)', () => {
    const { responses, chat } = buildProbeRequest('best removals company for elderly parents');
    assert.deepEqual(responses.tools, [{ type: 'web_search' }]);
    assert.equal(responses.input, 'best removals company for elderly parents');
    assert.deepEqual(chat.messages, [{ role: 'user', content: 'best removals company for elderly parents' }]);
  });

  test('a UK client: web search is asked from GB and the memory-only call is told the user is in the UK', () => {
    const country = { iso: 'GB', name: 'the United Kingdom' };
    const { responses, chat } = buildProbeRequest('best removals company for elderly parents', { country });
    assert.deepEqual(responses.tools, [{ type: 'web_search', user_location: { type: 'approximate', country: 'GB' } }]);
    assert.equal(responses.input, 'best removals company for elderly parents');
    assert.deepEqual(chat.messages, [
      { role: 'system', content: 'The user is located in the United Kingdom.' },
      { role: 'user', content: 'best removals company for elderly parents' },
    ]);
  });

  test('the location hint never names or describes the client', () => {
    const { chat } = buildProbeRequest('q', { country: { iso: 'GB', name: 'the United Kingdom' } });
    assert.equal(chat.messages.length, 2);
    assert.doesNotMatch(chat.messages[0].content, /chayce|company|recommend/i);
  });
});
