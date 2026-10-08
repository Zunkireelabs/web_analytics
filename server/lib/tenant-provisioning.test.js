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

describe('assessTenantReadiness — product tenants', () => {
  // Product-mode fakes. `product` null means the whole product query set
  // fails (missing schema), which must read as "could not be checked".
  function makeProductQuery({
    logins = 1, goals = 1, capabilities = 2, otherKnowledge = 1,
    conversionEvent = 'trial_signup', industries = ['technology'], profileIndustry = null,
    growthTableMissing = false,
  } = {}) {
    return async (sql) => {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.startsWith('SELECT count(*)::int AS n FROM users')) return { rows: [{ n: logins }] };
      if (norm.includes('FROM clients WHERE id')) return { rows: [{ has_token: true }] };
      if (norm.includes('FROM site_goals')) return { rows: [{ n: goals }] };
      if (norm.includes('FROM product_capabilities')) {
        return { rows: [
          ...(capabilities ? [{ kind: 'capability', n: capabilities }] : []),
          ...(otherKnowledge ? [{ kind: 'pricing', n: otherKnowledge }] : []),
        ] };
      }
      if (norm.includes('FROM product_growth_config')) {
        if (growthTableMissing) { const e = new Error('no table'); e.code = '42P01'; throw e; }
        return { rows: [{ conversion_event: conversionEvent, industries_json: JSON.stringify(industries), markets_json: '[]' }] };
      }
      if (norm.includes('FROM site_profiles')) return { rows: profileIndustry ? [{ industry: profileIndustry }] : [] };
      throw new Error(`unhandled SQL: ${sql}`);
    };
  }

  const productSite = (over = {}) => ({
    id: 500, name: 'Some SaaS', property_type: 'product',
    repo_owner: 'org', repo_name: 'repo', github_app_installation_id: 1,
    auto_remediation_enabled: true, auto_remediation_daily_limit: 10,
    url_file_map: {
      pages: { '/': 'index.html' }, patterns: [],
      renderCapabilities: { extensions: { '.md': { markdown: true } } },
      newContentTargets: { 'blog-outline': { dir: 'src/posts', extension: '.md' } },
      siteRoot: { designProfile: { derivedBy: 'design-agent' } },
    },
    ...over,
  });

  test('missing GSC/GA4 does not block a product tenant, and says why', async () => {
    const readiness = await assessTenantReadiness(productSite(), { query: makeProductQuery() });
    const analytics = readiness.items.find((i) => i.key === 'analytics');

    assert.equal(analytics.ok, null);
    assert.match(analytics.detail, /not applicable for a product tenant/);
    assert.equal(readiness.blocking.some((i) => i.key === 'analytics'), false);
  });

  test('a product tenant that HAS GSC/GA4 is still reported as having them', async () => {
    const site = productSite({ gsc_property: 'sc-domain:x.com', ga4_property_id: '9' });
    const readiness = await assessTenantReadiness(site, { query: makeProductQuery() });

    assert.equal(readiness.items.find((i) => i.key === 'analytics').ok, true);
  });

  test('a product tenant with no goal, no capability, no conversion event and no industry is NOT ready', async () => {
    // The whole point of the product branch: relaxing the website checks
    // alone would have declared this tenant fully provisioned while nothing
    // could actually ship for it.
    const readiness = await assessTenantReadiness(productSite(), {
      query: makeProductQuery({ goals: 0, capabilities: 0, otherKnowledge: 0, conversionEvent: null, industries: [] }),
    });

    assert.equal(readiness.ready, false);
    const keys = readiness.blocking.map((i) => i.key);
    assert.deepEqual(keys.sort(), ['product-capabilities', 'product-conversion-event', 'product-goal', 'product-industry']);
    for (const item of readiness.blocking) assert.ok(item.fix?.length, `${item.key} must carry a fix`);
  });

  test('a fully configured product tenant is ready', async () => {
    const readiness = await assessTenantReadiness(productSite(), { query: makeProductQuery() });
    assert.deepEqual(readiness.blocking, []);
    assert.equal(readiness.ready, true);
  });

  test('the industry falls back to the growth config when no GSC-derived profile exists', async () => {
    const readiness = await assessTenantReadiness(productSite(), { query: makeProductQuery({ profileIndustry: null, industries: ['education'] }) });
    const industry = readiness.items.find((i) => i.key === 'product-industry');

    assert.equal(industry.ok, true);
    assert.match(industry.detail, /education \(from product growth config\)/);
  });

  test('an unmigrated product_growth_config reads as could-not-check, never as a missing requirement', async () => {
    // A schema that has not been migrated is an environment fact. Reporting
    // it as misconfiguration would send staff to fix the wrong thing.
    const readiness = await assessTenantReadiness(productSite(), { query: makeProductQuery({ growthTableMissing: true, profileIndustry: 'technology' }) });

    assert.equal(readiness.items.find((i) => i.key === 'product-conversion-event').ok, null);
    assert.equal(readiness.blocking.some((i) => i.key.startsWith('product-')), false);
  });

  test('a website tenant gets no product items at all', async () => {
    const site = productSite({ property_type: 'website', gsc_property: 'sc-domain:x.com', ga4_property_id: '9' });
    const readiness = await assessTenantReadiness(site, { query: makeProductQuery() });

    assert.equal(readiness.items.some((i) => i.key.startsWith('product-')), false);
  });
});
