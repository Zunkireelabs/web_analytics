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

// One check per real precondition. `ok:false` items are the complete set of
// reasons a tenant will not run end to end -- each carries the specific
// command or action that resolves it, so an incomplete tenant is loud and
// actionable instead of silently half-working.
export async function assessTenantReadiness(site, { query = dbQuery } = {}) {
  if (!site?.id) throw new Error('assessTenantReadiness requires a site row');

  const siteId = site.id;
  const map = site.url_file_map || {};

  const [logins, analyst] = await Promise.all([
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
      ok: Boolean(site.gsc_property && site.ga4_property_id),
      detail: `gsc=${site.gsc_property ? 'set' : 'MISSING'}, ga4=${site.ga4_property_id ? 'set' : 'MISSING'}`,
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
