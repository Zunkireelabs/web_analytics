import pg from 'pg';
import 'dotenv/config';

// Neon serverless Postgres: use the POOLED connection string and keep max small.
// Serverless Postgres limits concurrent connections, so a tiny pool is correct.
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
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
export async function updateSiteRepoConfig({ siteId, repoOwner, repoName, repoUrl, repoDefaultBranch, techStack, githubPatEnvVar, urlFileMap }) {
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
