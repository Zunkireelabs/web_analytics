import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureAnalystClient, assessTenantReadiness } from './tenant-provisioning.js';

describe('ensureAnalystClient', () => {
  test('provisions via provisionAnalystClient using site.id, name, timezone', async () => {
    const calls = [];
    const result = await ensureAnalystClient(
      { id: 8862, name: 'Admizz Education', timezone: 'Asia/Kolkata' },
      { provision: async (siteId, opts) => { calls.push({ siteId, opts }); return { ok: true, has_mcp_token: false }; } },
    );
    assert.equal(result.ok, true);
    assert.equal(result.hasMcpToken, false);
    assert.deepEqual(calls, [{ siteId: 8862, opts: { name: 'Admizz Education', timezone: 'Asia/Kolkata' } }]);
  });

  test('falls back to a generated name and UTC when the site row is sparse', async () => {
    let seen;
    await ensureAnalystClient({ id: 5 }, { provision: async (id, opts) => { seen = opts; return { ok: true }; } });
    assert.deepEqual(seen, { name: 'Site 5', timezone: 'UTC' });
  });

  test('reports failure without throwing when the analyst service is unreachable', async () => {
    const result = await ensureAnalystClient({ id: 1, name: 'X' }, { provision: async () => ({ ok: false, error: 'Data Analyst Agent is unreachable right now' }) });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Data Analyst Agent is unreachable right now');
  });

  test('returns a no-site failure for a falsy site', async () => {
    const result = await ensureAnalystClient(null);
    assert.deepEqual(result, { ok: false, reason: 'no-site' });
  });
});

describe('assessTenantReadiness', () => {
  function makeQuery({ logins = 1, analystRow = { mcp_token_prefix: '(none)' } } = {}) {
    return async (sql) => {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.startsWith('SELECT count(*)::int AS n FROM users')) return { rows: [{ n: logins }] };
      if (norm.includes('FROM clients WHERE id')) {
        return analystRow ? { rows: [{ has_token: analystRow.mcp_token_prefix !== '(none)' && analystRow.mcp_token_prefix != null }] } : { rows: [] };
      }
      throw new Error(`unhandled SQL: ${sql}`);
    };
  }

  test('a fully provisioned tenant reports ready with no blocking items', async () => {
    const site = {
      id: 1, name: 'Zunkiree Labs', gsc_property: 'sc-domain:x.com', ga4_property_id: '123',
      repo_owner: 'org', repo_name: 'repo', github_app_installation_id: 999,
      auto_remediation_enabled: true, auto_remediation_daily_limit: 60,
      url_file_map: {
        pages: { '/': 'index.html' }, patterns: [],
        renderCapabilities: { extensions: { '.md': { markdown: true } } },
        newContentTargets: { 'landing-page': { dir: 'src/pages', extension: '.md' } },
        siteRoot: { designProfile: { derivedBy: 'design-agent' } },
      },
    };
    const readiness = await assessTenantReadiness(site, { query: makeQuery({ analystRow: { mcp_token_prefix: 'abc12345' } }) });
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.blocking, []);
  });

  test('a bare newly created tenant reports every missing precondition, each with a fix command', async () => {
    const site = { id: 42, name: 'New Co', url_file_map: {} };
    const readiness = await assessTenantReadiness(site, { query: makeQuery({ logins: 0, analystRow: null }) });
    assert.equal(readiness.ready, false);
    const keys = readiness.blocking.map((i) => i.key);
    assert.ok(keys.includes('login'));
    assert.ok(keys.includes('analytics'));
    assert.ok(keys.includes('analyst'));
    assert.ok(keys.includes('repo'));
    assert.ok(keys.includes('url-file-map'));
    assert.ok(keys.includes('render-capabilities'));
    assert.ok(keys.includes('new-content-targets'));
    assert.ok(keys.includes('autonomy'));
    for (const item of readiness.blocking) assert.ok(item.fix && item.fix.length > 0, `${item.key} must carry a fix`);
  });

  test('credentials item is not blocking (null) when no repo is connected yet', async () => {
    const site = { id: 7, name: 'X', url_file_map: {} };
    const readiness = await assessTenantReadiness(site, { query: makeQuery({ analystRow: null }) });
    const credentials = readiness.items.find((i) => i.key === 'credentials');
    assert.equal(credentials.ok, null);
  });

  test('a GitHub App installation counts as valid credentials even with no PAT env var set', async () => {
    const site = { id: 9, name: 'X', repo_owner: 'org', repo_name: 'repo', github_app_installation_id: 555, url_file_map: {} };
    const readiness = await assessTenantReadiness(site, { query: makeQuery({ analystRow: null }) });
    const credentials = readiness.items.find((i) => i.key === 'credentials');
    assert.equal(credentials.ok, true);
  });

  test('analyst schema absence is surfaced distinctly, not as a generic failure', async () => {
    const site = { id: 3, name: 'X', url_file_map: {} };
    const query = async (sql) => {
      if (sql.includes('FROM users')) return { rows: [{ n: 1 }] };
      const err = new Error('relation "clients" does not exist');
      err.code = '42P01';
      throw err;
    };
    const readiness = await assessTenantReadiness(site, { query });
    const analyst = readiness.items.find((i) => i.key === 'analyst');
    assert.equal(analyst.ok, false);
    assert.match(analyst.detail, /schema is not present/);
  });

  test('throws on a missing site rather than silently reporting empty readiness', async () => {
    await assert.rejects(() => assessTenantReadiness(null));
  });
});
