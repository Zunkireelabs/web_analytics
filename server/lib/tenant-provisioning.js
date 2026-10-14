import { query as dbQuery } from '../db.js';
import { provisionAnalystClient } from './data-analyst-client.js';

// Everything a tenant needs in order to actually run autonomously, in one
// place, so "onboarded" and "working" stop being different things.
//
// Two concerns live here:
//   - ensureAnalystClient: create the Data Analyst side of a tenant, which
//     nothing in the Node onboarding path previously did.
//   - assessTenantReadiness: report exactly which of the pipeline's
//     preconditions this tenant is missing, with the command that fixes each.
//
// Both are per-site by construction (every query takes site.id) and both are
// safe to re-run.

// Registers this site with the Data Analyst service via
// provisionAnalystClient (server/lib/data-analyst-client.js) -- the proper
// service boundary: that call goes through the analyst's own admin API
// (PUT /admin/clients/{id}), which handles the "no token yet" placeholder and
// encryption itself, rather than this app writing into a table it does not
// own. The Node app's sites.id is used as the analyst client_id by
// convention (data-analyst-agent/app/db/models.py's Client model).
//
// Creating this row is what makes the nightly Python pipeline (ingest ->
// stats -> anomalies -> forecasts -> insights) iterate this tenant at all --
// every stage selects on Client.status == 'active'. No token is required: a
// client with none runs off the shared database (DataSource) until one is
// minted and attached later.
export async function ensureAnalystClient(site, { provision = provisionAnalystClient } = {}) {
  if (!site?.id) return { ok: false, reason: 'no-site' };

  const result = await provision(site.id, { name: site.name || `Site ${site.id}`, timezone: site.timezone || 'UTC' });
  if (!result.ok) return { ok: false, reason: 'error', error: result.error };
  return { ok: true, created: true, hasMcpToken: result.has_mcp_token === true };
}

// Read straight through the injected `query` rather than through the store
// modules, for the same reason every other check here does: one injection
// point keeps this function testable with a single fake, and this module
// stays out of the store layer's import graph.
//
// A missing table is reported as "could not be checked" (null), never as a
// missing requirement — a schema that has not been migrated yet is an
// environment fact, and claiming the tenant is misconfigured because of it
// would send staff to fix the wrong thing.
async function loadProductReadiness(siteId, query) {
  const soft = (p) => p.then((r) => r.rows).catch(() => null);
  const [goals, knowledge, growth, profile] = await Promise.all([
    soft(query("SELECT count(*)::int AS n FROM site_goals WHERE site_id = $1 AND status = 'active'", [siteId])),
    soft(query(
      `SELECT kind, count(*)::int AS n FROM product_capabilities
        WHERE site_id = $1 AND status = 'verified' GROUP BY kind`,
      [siteId],
    )),
    soft(query(
      `SELECT pgc.conversion_event, pgc.industries_json, pgc.markets_json
         FROM product_growth_config pgc JOIN products p ON p.id = pgc.product_id
        WHERE p.site_id = $1`,
      [siteId],
    )),
    soft(query('SELECT industry FROM site_profiles WHERE site_id = $1', [siteId])),
  ]);

  const jsonArray = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string') return [];
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  };

  return {
    activeGoals: goals ? goals[0].n : null,
    // Split by kind, because the two matter for different things: a
    // 'capability' row is what classifyGapRelevance reads, while any other
    // kind (flow/pricing/audience/proof) is what the copy generators write
    // from. A tenant with only one of the two is half-provisioned.
    capabilityRows: knowledge ? knowledge.filter((r) => r.kind === 'capability').reduce((n, r) => n + r.n, 0) : null,
    otherKnowledgeRows: knowledge ? knowledge.filter((r) => r.kind !== 'capability').reduce((n, r) => n + r.n, 0) : null,
    conversionEvent: growth ? (growth[0]?.conversion_event || null) : null,
    growthIndustries: growth ? jsonArray(growth[0]?.industries_json) : null,
    growthMarkets: growth ? jsonArray(growth[0]?.markets_json) : null,
    profileIndustry: profile ? (profile[0]?.industry || null) : null,
    growthTableMissing: growth === null,
  };
}

function productReadinessItems(siteId, p) {
  const industry = p.profileIndustry || p.growthIndustries?.[0] || null;
  return [
    {
      key: 'product-goal',
      label: 'At least one active goal',
      ok: p.activeGoals == null ? null : p.activeGoals > 0,
      detail: p.activeGoals == null
        ? 'could not be checked'
        : p.activeGoals > 0
          ? `${p.activeGoals} active goal(s)`
          : 'none — every recommendation scores identically, so nothing can be prioritised',
      fix: `add a goal for site ${siteId} on the Analyst page (Goals), or POST /internal/sites/${siteId}/goals`,
    },
    {
      key: 'product-capabilities',
      label: 'Verified product capabilities',
      ok: p.capabilityRows == null ? null : p.capabilityRows > 0,
      detail: p.capabilityRows == null
        ? 'could not be checked'
        : p.capabilityRows > 0
          ? `${p.capabilityRows} capability row(s)${p.otherKnowledgeRows ? ` + ${p.otherKnowledgeRows} other knowledge row(s)` : ''}`
          : 'none — no keyword gap can be judged relevant to this product, and the copy generators have nothing real to write from',
      fix: `add capabilities for site ${siteId} on the Analyst page (Product knowledge)`,
    },
    {
      key: 'product-conversion-event',
      label: 'Conversion event',
      ok: p.growthTableMissing ? null : Boolean(p.conversionEvent),
      detail: p.growthTableMissing
        ? 'could not be checked'
        : p.conversionEvent
          ? p.conversionEvent
          : 'MISSING — nothing measures whether shipped work converted, so the engine cannot learn from its own output',
      fix: `set the conversion event for site ${siteId} in the Clients console (Product growth)`,
    },
    {
      key: 'product-industry',
      label: 'Industry recorded',
      ok: p.profileIndustry == null && p.growthIndustries == null ? null : Boolean(industry),
      detail: industry
        ? `${industry}${p.profileIndustry ? '' : ' (from product growth config)'}`
        : 'MISSING — trend radar runs on an empty feed list, so this tenant gets no trending topics at all',
      fix: `set the industry for site ${siteId} in the Clients console (Product growth), or run the onboarding script`,
    },
  ];
}

// One check per real precondition. `ok:false` items are the complete set of
// reasons a tenant will not run end to end -- each carries the specific
// command or action that resolves it, so an incomplete tenant is loud and
// actionable instead of silently half-working.
export async function assessTenantReadiness(site, { query = dbQuery } = {}) {
  if (!site?.id) throw new Error('assessTenantReadiness requires a site row');

  const siteId = site.id;
  const map = site.url_file_map || {};

  // A product tenant's requirements are genuinely different, not merely
  // laxer. Relaxing the GSC/GA4 check alone would make an empty product
  // tenant report "fully provisioned and will run end to end" while in fact
  // nothing can ship for it: with no goal nothing is prioritised, with no
  // capability row classifyGapRelevance has nothing to judge against, and
  // with no industry trend radar runs on an empty feed list. So the website
  // checks that do not apply are marked not-applicable AND the real product
  // preconditions are added.
  const isProduct = site.property_type === 'product';

  const [logins, analyst, product] = await Promise.all([
    query('SELECT count(*)::int AS n FROM users WHERE site_id = $1', [siteId])
      .then((r) => r.rows[0].n)
      .catch(() => null),
    // admin_clients.py's PUT stores mcp_token_prefix as the literal string
    // "(none)" (never NULL) when no real token was provided — that placeholder
    // is what distinguishes "registered, database-only" from "has a real MCP
    // token", per that route's own has_mcp_token computation.
    query("SELECT mcp_token_prefix IS NOT NULL AND mcp_token_prefix <> '(none)' AS has_token FROM clients WHERE id = $1", [siteId])
      .then((r) => (r.rows.length ? { exists: true, hasToken: r.rows[0].has_token } : { exists: false }))
      .catch((err) => (err.code === '42P01' ? { exists: false, schemaAbsent: true } : { exists: false, error: err.message })),
    isProduct ? loadProductReadiness(siteId, query) : Promise.resolve(null),
  ]);

  const hasCredential = Boolean(
    site.github_app_installation_id || process.env[site.github_pat_env_var || 'GITHUB_PAT'],
  );
  const pageCount = Object.keys(map.pages || {}).length;
  const patternCount = (map.patterns || []).length;
  const newTargets = Object.keys(map.newContentTargets || {});
  const renderExtensions = Object.keys(map.renderCapabilities?.extensions || {});

  const items = [
    {
      key: 'login',
      label: 'Client login',
      ok: logins == null ? null : logins > 0,
      detail: logins == null ? 'could not be checked' : `${logins} login(s)`,
      fix: 'npm run create-client -- <email> <password> --site-id ' + siteId,
    },
    {
      key: 'analytics',
      label: 'GSC + GA4 connected',
      // `null` is this function's existing "could not be checked / does not
      // apply" value, and `blocking` filters on === false, so a product
      // tenant is not held back by Search Console it has no reason to own.
      // Still reported, not hidden: a product tenant that DOES have a
      // marketing site benefits from both, and staff should see the choice.
      ok: isProduct
        ? (site.gsc_property && site.ga4_property_id ? true : null)
        : Boolean(site.gsc_property && site.ga4_property_id),
      detail: isProduct && !(site.gsc_property && site.ga4_property_id)
        ? 'not applicable for a product tenant — organic search data is optional here, the public-web and product-growth agents run without it'
        : `gsc=${site.gsc_property ? 'set' : 'MISSING'}, ga4=${site.ga4_property_id ? 'set' : 'MISSING'}`,
      fix: `npm run connect-site -- --site-id ${siteId} --gsc-property "sc-domain:example.com" --ga4-property-id <id>`,
    },
    {
      key: 'analyst',
      label: 'Data Analyst client (forecasts, anomalies, predictions)',
      ok: analyst.exists,
      detail: analyst.schemaAbsent
        ? 'the analyst service schema is not present in this database'
        : analyst.exists
          ? `registered${analyst.hasToken ? ' with an MCP token' : ' (no MCP token — analysed via the shared database)'}`
          : 'NOT registered — this tenant gets no forecasts, anomalies or predicted-decline recommendations',
      fix: `npm run connect-site -- --site-id ${siteId}   (provisions the analyst client automatically)`,
    },
    {
      key: 'repo',
      label: 'GitHub repo',
      ok: Boolean(site.repo_owner && site.repo_name),
      detail: site.repo_owner && site.repo_name ? `${site.repo_owner}/${site.repo_name}` : 'MISSING — nothing can ship',
      fix: `npm run connect-repo -- --site-id ${siteId} --repo-owner <org> --repo-name <repo>`,
    },
    {
      key: 'credentials',
      label: 'GitHub credentials',
      ok: site.repo_owner ? hasCredential : null,
      detail: site.github_app_installation_id
        ? `GitHub App installation ${site.github_app_installation_id}`
        : hasCredential
          ? `PAT via ${site.github_pat_env_var || 'GITHUB_PAT'}`
          : `no App installation and ${site.github_pat_env_var || 'GITHUB_PAT'} is unset`,
      fix: `npm run connect-repo -- --site-id ${siteId} --github-app-installation-id <id>`,
    },
    {
      key: 'url-file-map',
      label: 'URL → file mapping',
      ok: pageCount + patternCount > 0,
      detail: `${pageCount} page(s), ${patternCount} pattern(s)`,
      fix: `npm run connect-repo -- --site-id ${siteId}   (re-runs discovery)`,
    },
    {
      key: 'render-capabilities',
      label: 'Render capabilities',
      ok: renderExtensions.length > 0,
      detail: renderExtensions.length ? `${renderExtensions.length} extension(s) recorded` : 'MISSING — no net-new page can be applied',
      fix: `npm run connect-repo -- --site-id ${siteId}   (derives them from the repo)`,
    },
    {
      key: 'new-content-targets',
      label: 'New-page targets',
      ok: newTargets.length > 0,
      detail: newTargets.length ? newTargets.join(', ') : 'none — landing-page/blog/legal generators stay blocked',
      fix: `npm run connect-repo -- --site-id ${siteId}   (derives them from the repo)`,
    },
    {
      key: 'design-memory',
      label: 'Design Memory',
      ok: Boolean(map.siteRoot?.designProfile),
      detail: map.siteRoot?.designProfile ? 'derived' : 'not derived yet — queued on repo connect, runs in the Design Agent worker',
      fix: 'starts automatically; check the design_generate jobs in execution_jobs',
    },
    {
      key: 'autonomy',
      label: 'Autonomous remediation',
      ok: site.auto_remediation_enabled === true,
      detail: site.auto_remediation_enabled ? `enabled (limit ${site.auto_remediation_daily_limit}/day)` : 'disabled — nothing ships unattended',
      fix: `granted automatically on first repo connect; otherwise enable it for site ${siteId} in the Clients console`,
    },
    ...(product ? productReadinessItems(siteId, product) : []),
  ];

  const blocking = items.filter((i) => i.ok === false);
  return { siteId, ready: blocking.length === 0, items, blocking };
}

// Shared console rendering so all three CLI scripts end with the same
// unambiguous statement of what is and is not provisioned.
export function printReadiness(readiness, log = console.log) {
  log('\nTenant readiness:');
  for (const item of readiness.items) {
    const mark = item.ok === true ? 'ok  ' : item.ok === false ? 'MISSING' : '?   ';
    log(`  [${mark}] ${item.label}: ${item.detail}`);
  }
  if (readiness.ready) {
    log('\nThis tenant is fully provisioned and will run end to end on the next daily cycle.');
  } else {
    log(`\n${readiness.blocking.length} item(s) block full autonomy. To fix:`);
    for (const item of readiness.blocking) log(`  - ${item.label}\n      ${item.fix}`);
  }
}
