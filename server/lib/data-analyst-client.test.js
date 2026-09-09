import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Real fetch is mocked at the global level (this module calls the built-in
// fetch, not an injected client) — same pattern node's own docs use for
// mocking globals via mock.method.

describe('provisionAnalystClient', () => {
  test('PUTs to /admin/clients/{siteId} with no token when onboarding a brand-new site', async () => {
    const calls = [];
    mock.method(globalThis, 'fetch', async (url, opts) => {
      calls.push({ url: String(url), opts });
      return { ok: true, json: async () => ({ id: 42, name: 'Acme Co', status: 'active', has_mcp_token: false }) };
    });

    const { provisionAnalystClient } = await import('./data-analyst-client.js');
    const result = await provisionAnalystClient(42, { name: 'Acme Co', timezone: 'Asia/Kolkata' });

    assert.equal(result.ok, true);
    assert.equal(result.has_mcp_token, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/admin\/clients\/by-site\/42$/);
    assert.equal(calls[0].opts.method, 'PUT');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.name, 'Acme Co');
    assert.equal(body.timezone, 'Asia/Kolkata');
    assert.equal(body.token, null, 'onboarding with no MCP token yet must not send a fabricated one');

    mock.restoreAll();
  });

  test('a later call with a real token upgrades the client without needing a fresh site row', async () => {
    const calls = [];
    mock.method(globalThis, 'fetch', async (url, opts) => {
      calls.push({ url: String(url), opts });
      return { ok: true, json: async () => ({ id: 42, name: 'Acme Co', status: 'active', has_mcp_token: true }) };
    });

    const { provisionAnalystClient } = await import('./data-analyst-client.js');
    const result = await provisionAnalystClient(42, { name: 'Acme Co', token: 'raw-mcp-token-abc', permissionLevel: 'automation' });

    assert.equal(result.ok, true);
    assert.equal(result.has_mcp_token, true);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.token, 'raw-mcp-token-abc');
    assert.equal(body.permission_level, 'automation');

    mock.restoreAll();
  });

  test('never throws when the Data Analyst service is unreachable — onboarding must not fail because of it', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });

    const { provisionAnalystClient } = await import('./data-analyst-client.js');
    const result = await provisionAnalystClient(99, { name: 'Late Client' });

    assert.equal(result.ok, false);
    assert.ok(result.error, 'a failure must be reported, not swallowed silently');

    mock.restoreAll();
  });

  test('surfaces a non-2xx response as ok:false rather than throwing', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false, status: 500, json: async () => ({ detail: 'internal error' }),
    }));

    const { provisionAnalystClient } = await import('./data-analyst-client.js');
    const result = await provisionAnalystClient(7, { name: 'X' });

    assert.equal(result.ok, false);
    assert.match(result.error, /internal error/);

    mock.restoreAll();
  });
});
