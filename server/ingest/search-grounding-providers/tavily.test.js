import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TAVILY_API_KEY = 'test-key';
process.env.TAVILY_MAX_QUERIES_PER_DAY = '2';

const { configured, searchSources, _resetQuotaForTests } = await import('./tavily.js');

let originalFetch;
before(() => { originalFetch = global.fetch; });
after(() => { global.fetch = originalFetch; });
beforeEach(() => { _resetQuotaForTests(); });

describe('tavily adapter', () => {
  test('configured() reflects TAVILY_API_KEY presence', () => {
    assert.equal(configured(), true);
  });

  test('maps a successful response to {title, url, content} triples', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [
          { title: 'A', url: 'https://a.com', content: 'Excerpt about A.' },
          { title: 'B', url: 'https://b.com' },
        ],
      }),
    });
    const sources = await searchSources('query', 3);
    assert.deepEqual(sources, [
      { title: 'A', url: 'https://a.com', content: 'Excerpt about A.' },
      { title: 'B', url: 'https://b.com', content: undefined },
    ]);
  });

  test('missing TAVILY_API_KEY throws before making any request', async () => {
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ({ results: [] }) }; };
    try {
      assert.equal(configured(), false);
      await assert.rejects(() => searchSources('query', 3), /TAVILY_API_KEY is not set/);
      assert.equal(called, false);
    } finally {
      process.env.TAVILY_API_KEY = original;
    }
  });

  test('maps a 429/432/433 response to a distinct quota-exhausted error', async () => {
    global.fetch = async () => ({ ok: false, status: 432, json: async () => ({ detail: { error: 'plan limit' } }) });
    await assert.rejects(() => searchSources('query', 3), /Tavily account quota is exhausted/);
  });

  test('maps a generic HTTP failure to a non-quota-specific message', async () => {
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(() => searchSources('query', 3), /temporarily unavailable/);
  });

  test('enforces the strict internal daily cap before calling out at all', async () => {
    let calls = 0;
    global.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ results: [] }) }; };
    await searchSources('q1', 3);
    await searchSources('q2', 3);
    await assert.rejects(() => searchSources('q3', 3), /daily query cap reached/);
    assert.equal(calls, 2);
  });
});
