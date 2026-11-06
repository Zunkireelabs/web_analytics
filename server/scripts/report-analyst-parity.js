// READ-ONLY check that the Data Analyst's findings reach the app's recommendation queue. Run it, and read it, BEFORE switching the
// Python draft step off (ANALYST_DRAFT_TRIGGER=off). It changes nothing.
//
//   node server/scripts/report-analyst-parity.js [--days 14] [--site <id>] [--json]
//
// Two databases may be involved: the app's (DATABASE_URL) and, in staging and production, the Data Analyst's own
// (ANALYST_DATABASE_URL). When ANALYST_DATABASE_URL is unset they are the same (local development). Both are read inside READ ONLY
// transactions, and a remote one needs an explicit REPORT_ALLOW_REMOTE_DB=yes.
//
// The Python client_id is the app's site id by convention (lib/tenant-provisioning.js).
import 'dotenv/config';
import pg from 'pg';
import { pool as appPool } from '../db.js';
import { seoDraftEligibility } from '../agents/lib/analyst-seo-mapping.js';
import { recommendationPageKey } from '../agents/lib/recommendation-coordinator.js';
import { buildParityReport, formatParity } from '../lib/analyst-parity/report.js';

const hostOf = (u) => { try { return new URL(u || '').hostname; } catch { return ''; } };
const isLocal = (h) => ['localhost', '127.0.0.1', '::1', 'host.docker.internal', ''].includes(h);
const analystUrl = process.env.ANALYST_DATABASE_URL || process.env.DATABASE_URL;
for (const u of [process.env.DATABASE_URL, analystUrl]) {
  if (!isLocal(hostOf(u)) && process.env.REPORT_ALLOW_REMOTE_DB !== 'yes') {
    console.error(`Refusing to run: "${hostOf(u)}" is not a local database. Read-only, but reading a shared database needs an explicit OK: set REPORT_ALLOW_REMOTE_DB=yes.`);
    process.exit(2);
  }
}

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const days = Math.max(1, Number(arg('--days', 14)) || 14);
const onlySite = arg('--site', null);
const asJson = argv.includes('--json');

const analystPool = analystUrl === process.env.DATABASE_URL ? appPool : new pg.Pool({ connectionString: analystUrl, ssl: isLocal(hostOf(analystUrl)) ? false : { rejectUnauthorized: false } });
const a = await analystPool.connect();
const p = analystPool === appPool ? a : await appPool.connect();
try {
  await a.query('BEGIN TRANSACTION READ ONLY');
  if (p !== a) await p.query('BEGIN TRANSACTION READ ONLY');

  const sites = (await p.query(`SELECT * FROM sites WHERE status = 'active' ${onlySite ? 'AND id = $1' : ''} ORDER BY id`, onlySite ? [onlySite] : [])).rows;
  const reports = [];
  for (const site of sites) {
    const insights = (await a.query(
      `SELECT id, client_id, metric_key, dimension_type, dimension_value, period_start::text AS period_start, insight_type, severity, evidence, generated_at
         FROM insights WHERE client_id = $1 AND generated_at > now() - ($2 || ' days')::interval`, [site.id, String(days)])).rows;
    if (!insights.length) continue;
    const recommendations = (await p.query(
      `SELECT id, site_id, page, recommendation_type, status, finding_ids, detecting_agents, supporting_agents FROM recommendations WHERE site_id = $1`, [site.id])).rows;
    reports.push(buildParityReport({ site, insights, recommendations, eligibility: seoDraftEligibility, keyOf: recommendationPageKey }));
  }
  if (asJson) console.log(JSON.stringify(reports, null, 2));
  else if (!reports.length) console.log(`No analyst insights from the last ${days} day(s) for any active project. Nothing to compare: this is NOT a pass.`);
  else console.log(formatParity(reports));
} finally {
  await a.query('ROLLBACK').catch(() => {});
  if (p !== a) await p.query('ROLLBACK').catch(() => {});
  a.release(); if (p !== a) p.release();
  await appPool.end().catch(() => {}); if (analystPool !== appPool) await analystPool.end().catch(() => {});
}
process.exit(0);
