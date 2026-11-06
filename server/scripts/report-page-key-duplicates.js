// READ-ONLY duplicate report for the proposed canonical page key. It changes nothing.
//
//   node server/scripts/report-page-key-duplicates.js [--json] [--site <id>]
//
// It runs inside a transaction opened READ ONLY, so the database itself refuses any write, then rolls back. It still refuses to
// run against a remote database unless that is said out loud (REPORT_ALLOW_REMOTE_DB=yes), because reading a production table is
// a decision for a person, not a default.
import 'dotenv/config';
import { pool } from '../db.js';
import { buildDuplicateReport, formatReport } from '../lib/page-key/duplicate-report.js';
import { establishEquivalence } from '../lib/page-key/equivalence.js';
import { splitPageKey } from '../lib/page-key/canonical.js';

const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
const local = ['localhost', '127.0.0.1', '::1', 'host.docker.internal', ''].includes(host);
if (!local && process.env.REPORT_ALLOW_REMOTE_DB !== 'yes') {
  console.error(`Refusing to run: DATABASE_URL points at "${host}", not a local database. This report is read-only, but reading a shared database needs an explicit OK. Set REPORT_ALLOW_REMOTE_DB=yes to proceed.`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const onlySite = argv.includes('--site') ? Number(argv[argv.indexOf('--site') + 1]) : null;
// --verify-live: for every collision that needs a decision (trailing slash, scheme, unverified www), fetch both URLs from the
// public site and record whether a redirect or a canonical tag proves they are one page. Plain GETs of public pages, through the
// free audit's guarded fetcher. Without this flag nothing is fetched.
const verifyLive = argv.includes('--verify-live');

const client = await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const filter = onlySite ? 'AND site_id = $1' : '';
  const params = onlySite ? [onlySite] : [];
  const recs = (await client.query(
    `SELECT id, site_id, page, recommendation_type, status, detecting_agents, supporting_agents, finding_ids, first_detected_at
       FROM recommendations WHERE status = 'open' ${filter} ORDER BY id`, params)).rows;
  const total = Number((await client.query(`SELECT COUNT(*) FROM recommendations WHERE true ${filter}`, params)).rows[0].count);
  const sites = (await client.query('SELECT id, name, website_domain FROM sites')).rows;
  const counts = new Map((await client.query(
    `SELECT r.id, COUNT(d.id)::int AS n FROM recommendations r
       JOIN drafts d ON d.site_id = r.site_id AND d.finding_id = ANY(r.finding_ids) AND d.status <> 'abandoned'
      WHERE r.status = 'open' ${onlySite ? 'AND r.site_id = $1' : ''} GROUP BY r.id`, params)).rows.map((r) => [Number(r.id), r.n]));
  const report = buildDuplicateReport({ recommendations: recs, sites, draftCounts: counts });
  report.totals.rows = total;
  report.source = { database: host || '(local socket)', readOnlyTransaction: true, generatedAt: new Date().toISOString() };
  if (verifyLive) {
    const { fetchMainPage, normalizeUrl } = await import('../free-audit/fetchPage.js');
    const fetchPage = (u) => fetchMainPage(normalizeUrl(u));
    for (const c of report.collisions.filter((x) => x.level !== 'safe')) {
      const [a, b] = c.rows.map((r) => splitPageKey(r.original)?.url);
      c.liveEvidence = a && b ? await establishEquivalence(a, b, { fetchPage }) : { equivalent: false, detail: 'no URL to test' };
      c.mergeAllowed = Boolean(c.liveEvidence.equivalent);
    }
  }
  console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));
  if (verifyLive && !asJson) {
    for (const c of report.collisions.filter((x) => x.liveEvidence)) {
      console.log(`\nlive evidence for site ${c.siteId} ${c.type} #${c.keep}/${c.foldIn.join(',')}: ${c.liveEvidence.equivalent ? `EQUIVALENT by ${c.liveEvidence.basis}` : 'NOT equivalent'}, ${c.liveEvidence.detail}`);
      console.log(`  final URLs: ${c.liveEvidence.evidence?.finalA} | ${c.liveEvidence.evidence?.finalB}`);
    }
  }
} finally {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  await pool.end().catch(() => {});
}
process.exit(0);
