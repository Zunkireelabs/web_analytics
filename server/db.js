import pg from 'pg';
import 'dotenv/config';

// Neon serverless Postgres: DATABASE_URL must be the POOLED (PgBouncer,
// "-pooler" hostname) connection string, never the direct one — the direct
// endpoint's connection ceiling is low enough that Command Center's ~15-20
// queries per page load can exhaust a pool of any size under light
// concurrency (two tabs, a reload racing an in-flight request). Once
// genuinely pooled, `max: 10` is safely within Neon's pooler limits.
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

// Under node's own test runner (NODE_TEST_CONTEXT is set automatically by
// `node --test`, whether that's `npm test` or a single file run by hand),
// refuse to connect to anything but a local database. Real incident,
// 2026-09-03: several *.test.js files write real fixture rows on every run
// and either had no DATABASE_URL guard at all, or a
// `DATABASE_URL ||= 'postgres://...localhost.../test'` fallback that ESM's
// import-hoisting made a no-op whenever the same file also imports this
// module — the `import 'dotenv/config'` above already ran and set
// DATABASE_URL from .env before the fallback line's own text position ever
// executed, so the fallback silently never fired. Dozens of
// `status='active'` test-fixture sites accumulated in the real staging
// database over time as a result, and a daily cron job choking on one of
// them (a hung, untimed-out GitHub call — see github/client.js) is what
// surfaced this while diagnosing that hang. Enforced here, the one
// chokepoint every DB access — test or not — actually goes through, so no
// individual test file's guard (present, absent, or silently shadowed)
// matters.
if (process.env.NODE_TEST_CONTEXT) {
  const dbHost = new URL(process.env.DATABASE_URL).hostname;
  if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(dbHost)) {
    throw new Error(
      `Refusing to run tests against a non-local DATABASE_URL (host: ${dbHost}). ` +
      'Tests must run against a local database — set DATABASE_URL=postgres://test:test@localhost:5432/test ' +
      'before running tests, or make sure nothing else in your shell/.env has already set it to a real one.'
    );
  }
}

// DB_POOL_MAX defaults to 10, unchanged from before this was configurable —
// the standalone MCP process (mcp-server/index.js) overrides it smaller
// (read-heavy, short queries) since it holds its own independent Pool
// against this same DATABASE_URL, and two processes' pools now share
// whatever connection ceiling Neon's pooler enforces.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  ssl: { rejectUnauthorized: false },
});

export const query = (text, params) => pool.query(text, params);

// Fetch the configured site row, creating it from env on first run if absent.
export async function getOrCreateSite() {
  const gsc = process.env.GSC_PROPERTY;
  const ga4 = process.env.GA4_PROPERTY_ID;
  if (!gsc || !ga4) {
    throw new Error('GSC_PROPERTY and GA4_PROPERTY_ID must be set in .env.');
  }
  const found = await query(
    'SELECT * FROM sites WHERE gsc_property = $1 AND ga4_property_id = $2',
    [gsc, ga4]
  );
  if (found.rows.length) return found.rows[0];

  const inserted = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [process.env.SITE_NAME || 'My Website', gsc, ga4, process.env.TZ || 'Asia/Kolkata']
  );
  return inserted.rows[0];
}

// Create a brand-new client site with no GSC/GA4 connected yet. Distinct
// from getOrCreateSite(), which is env-driven and used only by the
// cron/job/ingest pipeline for the one site configured in this instance's
// .env — this is for provisioning additional clients (see
// server/scripts/create-client.js).
export async function createClientSite({ name, websiteDomain, timezone }) {
  const inserted = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, website_domain)
     VALUES ($1, NULL, NULL, $2, $3) RETURNING *`,
    [name, timezone || 'Asia/Kolkata', websiteDomain || null]
  );
  return inserted.rows[0];
}

// Attach GSC/GA4 (and optionally email recipient / logo) to a site created
// via createClientSite() — only the fields actually passed are updated.
// Once both gsc_property and ga4_property_id are set, job.js's
// listConnectedSites() picks the site up automatically on the next cron tick.
export async function updateSiteConnection({ siteId, gscProperty, ga4PropertyId, reportEmailTo, logoDataUrl }) {
  const fields = [];
  const values = [];
  let i = 1;
  const set = (column, value) => { fields.push(`${column} = $${i++}`); values.push(value); };

  if (gscProperty !== undefined) set('gsc_property', gscProperty);
  if (ga4PropertyId !== undefined) set('ga4_property_id', ga4PropertyId);
  if (reportEmailTo !== undefined) set('report_email_to', reportEmailTo);
  if (logoDataUrl !== undefined) set('logo_data_url', logoDataUrl);

  if (!fields.length) throw new Error('updateSiteConnection: nothing to update.');

  values.push(siteId);
  const { rows } = await query(
    `UPDATE sites SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

// Attach a GitHub repo (and optionally tech stack / url_file_map) to a site
// for the Action Center's "apply approved draft as a PR" flow (see
// server/scripts/connect-repo.js, migration 028). Same partial-update shape
// as updateSiteConnection above — only fields actually passed are touched.
export async function updateSiteRepoConfig({ siteId, repoOwner, repoName, repoUrl, repoDefaultBranch, techStack, githubPatEnvVar, githubAppInstallationId, urlFileMap }) {
  const fields = [];
  const values = [];
  let i = 1;
  const set = (column, value) => { fields.push(`${column} = $${i++}`); values.push(value); };

  if (repoOwner !== undefined) set('repo_owner', repoOwner);
  if (repoName !== undefined) set('repo_name', repoName);
  if (repoUrl !== undefined) set('repo_url', repoUrl);
  if (repoDefaultBranch !== undefined) set('repo_default_branch', repoDefaultBranch);
  if (techStack !== undefined) set('tech_stack', techStack);
  if (githubPatEnvVar !== undefined) set('github_pat_env_var', githubPatEnvVar);
  // null is meaningful here — it moves a site back off the App onto its PAT.
  if (githubAppInstallationId !== undefined) set('github_app_installation_id', githubAppInstallationId);
  if (urlFileMap !== undefined) set('url_file_map', JSON.stringify(urlFileMap));

  if (!fields.length) throw new Error('updateSiteRepoConfig: nothing to update.');

  values.push(siteId);
  const { rows } = await query(
    `UPDATE sites SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

// Uninstall-time cleanup for the GitHub App installation webhook
// (server/routes/webhooks.js) — moves every site still pointing at a
// deleted installation id back onto its PAT, without needing the payload's
// `repositories` list (absent for "all repositories" installs; see the
// webhook handler's own comment). Matches by installation id rather than
// by repo, so it's correct even if repo_owner/repo_name were renamed after
// the App was installed.
export async function clearGithubAppInstallation(installationId) {
  const { rows } = await query(
    'UPDATE sites SET github_app_installation_id = NULL WHERE github_app_installation_id = $1 RETURNING *',
    [installationId]
  );
  return rows;
}

// Persists the outcome of an audit-url-file-map.js run (migration 088), so
// "has this site's Action Center config actually been verified clean" is a
// queryable fact — read by integrations/github.js's Integration Health check
// to nudge when a repo is connected but was never audited, or was audited
// with gaps still open.
export async function recordActionCenterConfigCheck(siteId, gapCount) {
  const { rows } = await query(
    `UPDATE sites SET action_center_config_checked_at = now(), action_center_config_gap_count = $2
     WHERE id = $1 RETURNING *`,
    [siteId, gapCount]
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

// Tenant lifecycle (PLATFORM-ADMIN-DESIGN.md §D, §K Phase 3). Each function
// bakes its required source status into the UPDATE's WHERE clause and
// returns null when the row didn't match — the same atomic-claim shape
// signup_requests approval already uses for its race guard — so a route
// handler never needs a separate read-then-write check for "is this
// transition even legal from the current state." Hard delete is Phase 3.5,
// not here.
//
// deactivated_at/deleted_at are treated as *current-state* markers, not raw
// history (the richer, actor-attributed history lives in audit_log):
// non-null deactivated_at means "currently suspended since this time,"
// non-null deleted_at means "currently soft-deleted since this time." Both
// clear back to NULL on reactivate, whichever state it reactivated from.

export async function suspendSite(siteId) {
  const { rows } = await query(
    `UPDATE sites SET status = 'suspended', deactivated_at = now()
     WHERE id = $1 AND status = 'active' RETURNING *`,
    [siteId]
  );
  return rows[0] || null;
}

export async function reactivateSite(siteId) {
  const { rows } = await query(
    `UPDATE sites SET status = 'active', deactivated_at = NULL, deleted_at = NULL
     WHERE id = $1 AND status IN ('suspended', 'soft_deleted') RETURNING *`,
    [siteId]
  );
  return rows[0] || null;
}

// Only reachable from 'suspended', not directly from 'active' — matches the
// state machine in §D's diagram (ACTIVE -> SUSPENDED -> SOFT-DELETED), a
// deliberate two-step path rather than a shortcut straight to soft-deleted.
export async function softDeleteSite(siteId) {
  const { rows } = await query(
    `UPDATE sites SET status = 'soft_deleted', deleted_at = now()
     WHERE id = $1 AND status = 'suspended' RETURNING *`,
    [siteId]
  );
  return rows[0] || null;
}

// Phase 3.5 — irreversible. Only reachable from 'soft_deleted' (§D's
// diagram: SUSPENDED -> SOFT-DELETED -> hard-delete -> GONE), same atomic
// guard-in-the-WHERE-clause shape as the three functions above: if the
// status changed out from under the caller between its own read and this
// statement (e.g. a Platform Admin reactivated it in the meantime), this
// returns null instead of deleting a row nobody meant to delete anymore.
// Relies entirely on migration 064's FK corrections (growth_targets/
// integration_health -> CASCADE, signup_requests -> SET NULL) — without
// those, this DELETE fails on any tenant with rows in those three tables.
export async function hardDeleteSite(siteId) {
  const { rows } = await query(
    `DELETE FROM sites WHERE id = $1 AND status = 'soft_deleted' RETURNING id, name`,
    [siteId]
  );
  return rows[0] || null;
}

// Sets the trusted ceiling on what an OAuth-issued MCP token can ever reach
// for this site (migration 061) — staff-only, never reachable from a
// client-facing route. See server/routes/oauth-consent.js and
// mcp-server/oauth-provider.js, which read this value to compute an OAuth
// grant's effective permission_level; a client's requested scope can only
// narrow it, never raise it.
export async function updateSiteOauthPolicy({ siteId, oauthMaxPermissionLevel }) {
  const { rows } = await query(
    `UPDATE sites SET oauth_max_permission_level = $1 WHERE id = $2 RETURNING *`,
    [oauthMaxPermissionLevel, siteId]
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

// Sitewide ceiling on how many pages may get a visible on-page FAQ block
// (migration 071) — read by render-inspector.js's inspectRenderMode via
// countVisibleFaqDrafts (server/store/drafts.js) to keep visible FAQs
// selective rather than appearing on every eligible page.
// Per-site consent for cross-client learned repair (migration 099): may this
// site be fixed using a repair whose only evidence comes from ANOTHER
// client's site. Deliberately distinct from auto_remediation_enabled (089),
// which only covers acting unattended on this site's own findings — a client
// can reasonably agree to one and not the other, and
// interceptWithLearnedRepairs requires both.
export async function updateSiteLearnedRepair({ siteId, enabled }) {
  const { rows } = await query(
    `UPDATE sites SET learned_repair_enabled = $1 WHERE id = $2 RETURNING *`,
    [enabled, siteId]
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

export async function updateSiteVisibleFaqCap({ siteId, visibleFaqCap }) {
  const { rows } = await query(
    `UPDATE sites SET visible_faq_cap = $1 WHERE id = $2 RETURNING *`,
    [visibleFaqCap, siteId]
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

// The unattended auto-remediation loop's per-site switch and daily ceiling
// (migrations 089 and 101), read by agents/lib/auto-remediation.js.
//
// Until this existed, `auto_remediation_enabled` was read in exactly one
// place and written in NONE — no route, no UI, no script — so the only way
// to turn the autonomous loop on was a hand-written SQL UPDATE against
// production. That is why the loop had never run for any site: not because
// anyone decided against it, but because nothing could flip the switch.
//
// Both fields update together and are validated by the caller
// (routes/clients.js, platform_admin only): enabling a site and setting its
// ceiling are one decision, and splitting them would allow the intermediate
// state nobody wants — enabled with a stale limit somebody else set.
export async function updateSiteAutoRemediation({ siteId, enabled, dailyLimit }) {
  const { rows } = await query(
    `UPDATE sites SET auto_remediation_enabled = $1, auto_remediation_daily_limit = $2 WHERE id = $3 RETURNING *`,
    [enabled, dailyLimit, siteId]
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

// Records staff sign-off on a site's design profile (migration 132) — pinned
// to `fingerprint` (design-integrity-gate's designReviewFingerprint), so a
// later re-derivation that actually changes what will ship can be told apart
// from one that doesn't (designReviewState reads this same column pair).
// `reviewedBy` is the staff user's id (req.userId after requireAuth) — never
// null on a real approval; the column itself stays nullable only because
// ON DELETE SET NULL must remain possible for a since-deleted staff account,
// not because an anonymous approval is a real case this route ever takes.
export async function updateSiteDesignReview({ siteId, reviewedBy, fingerprint }) {
  const { rows } = await query(
    `UPDATE sites SET design_review_at = now(), design_review_by = $1, design_review_fingerprint = $2 WHERE id = $3 RETURNING *`,
    [reviewedBy, fingerprint, siteId]
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

// The site's real author/byline identity (migration 090) — read by
// generators/schema.js (populates Article/BlogPosting/NewsArticle's
// `author` field) and generators/expand-content.js (drafts a real, on-page
// byline for the `author-byline` GEO-signal focus instead of a
// "[Author Name]" placeholder) whenever author_name is set. Passing null for
// a field clears it — same semantics as updateSiteRepoConfig.
export async function updateSiteAuthorProfile({ siteId, authorName, authorRole, authorUrl, requireVisibleByline }) {
  const { rows } = await query(
    `UPDATE sites SET author_name = $1, author_role = $2, author_url = $3, require_visible_byline = $4 WHERE id = $5 RETURNING *`,
    [authorName || null, authorRole || null, authorUrl || null, !!requireVisibleByline, siteId]
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}

// Count of pages that already had a visible, organic FAQ before this tool
// ever ran (migration 074) — combined with countVisibleFaqDrafts to make
// visible_faq_cap a true sitewide ceiling. Set only via the staff-triggered
// "Recalculate FAQ baseline" action (routes/clients.js), never inferred.
export async function updateSiteVisibleFaqBaseline({ siteId, visibleFaqBaseline }) {
  const { rows } = await query(
    `UPDATE sites SET visible_faq_baseline = $1 WHERE id = $2 RETURNING *`,
    [visibleFaqBaseline, siteId]
  );
  if (!rows.length) throw new Error(`No site found with id ${siteId}.`);
  return rows[0];
}
