import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProbeRequest, answerFromMessage, webSearchEnabled } from './anthropic.js';

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

describe('anthropic web search probe', () => {
  test('off by default: no tools, exactly the old request', () => {
    const body = buildProbeRequest('q', { webSearch: false });
    assert.equal(body.tools, undefined);
    assert.equal(body.max_tokens, 600);
    assert.equal(webSearchEnabled(), false);
  });

  test('on: the basic web_search server tool, a bounded number of searches, located in the asker\'s country', () => {
    const body = buildProbeRequest('q', { webSearch: true, country: { iso: 'GB', name: 'the United Kingdom' } });
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'GB' } }]);
    assert.equal(body.system, 'The user is located in the United Kingdom.');
    assert.ok(body.max_tokens > 600);
  });

  test('the answer keeps its prose and appends the URLs it cited; search-result blocks are not read as prose', () => {
    const msg = { content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://noise.example/', title: 't' }] },
      { type: 'text', text: 'Try Acme Removals. ', citations: [{ type: 'web_search_result_location', url: 'https://acme.example/a' }] },
      { type: 'text', text: 'Also Beta.', citations: [{ type: 'web_search_result_location', url: 'https://acme.example/b' }, { type: 'web_search_result_location', url: 'https://beta.example/' }] },
    ] };
    const { raw, citedUrls } = answerFromMessage(msg);
    assert.deepEqual(citedUrls, ['https://acme.example/a', 'https://acme.example/b', 'https://beta.example/']);
    assert.ok(raw.startsWith('Try Acme Removals. Also Beta.'));
    assert.ok(raw.includes('Sources:\nhttps://acme.example/a'));
    assert.ok(!raw.includes('noise.example'));
  });

  test('a failed search (error object, no citations) still returns the text and no sources section', () => {
    const msg = { content: [
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
      { type: 'text', text: 'From memory only.' },
    ] };
    assert.deepEqual(answerFromMessage(msg), { raw: 'From memory only.', citedUrls: [] });
  });
});
