// DRY RUN ONLY. Prints the exact page-key migration that WOULD run, for review. There is no write path in this file.
//
//   node server/scripts/plan-page-key-migration.js [--json]
//
// 1. reads open recommendations (READ ONLY transaction), 2. derives each project's URL policy from live evidence (public GETs),
// 3. lists the collisions whose merge is PROVEN by a redirect or canonical tag, with the row kept, the rows folded in, and the
// statements a reviewed merge would execute. Collisions without evidence are listed as "keep apart".
import 'dotenv/config';
import { pool } from '../db.js';
import { buildDuplicateReport } from '../lib/page-key/duplicate-report.js';
import { establishEquivalence } from '../lib/page-key/equivalence.js';
import { deriveSiteUrlPolicy } from '../lib/page-key/site-policy.js';
import { splitPageKey, bareHost } from '../lib/page-key/canonical.js';

const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1', 'host.docker.internal', ''].includes(host) && process.env.REPORT_ALLOW_REMOTE_DB !== 'yes') {
  console.error(`Refusing: "${host}" is not local. Read-only, but set REPORT_ALLOW_REMOTE_DB=yes to read a shared database.`); process.exit(2);
}
const { fetchMainPage, normalizeUrl } = await import('../free-audit/fetchPage.js');
const fetchPage = (u) => fetchMainPage(normalizeUrl(u));

const c = await pool.connect();
let recs; let sites; const counts = new Map();
try {
  await c.query('BEGIN TRANSACTION READ ONLY');
  recs = (await c.query(`SELECT id, site_id, page, recommendation_type, status, detecting_agents, supporting_agents, finding_ids, priority, confidence, first_detected_at FROM recommendations WHERE status = 'open' ORDER BY id`)).rows;
  sites = (await c.query(`SELECT id, name, website_domain FROM sites WHERE status = 'active'`)).rows;
  for (const r of (await c.query(`SELECT r.id, COUNT(d.id)::int n FROM recommendations r JOIN drafts d ON d.site_id = r.site_id AND d.finding_id = ANY(r.finding_ids) AND d.status <> 'abandoned' WHERE r.status = 'open' GROUP BY r.id`)).rows) counts.set(Number(r.id), r.n);
} finally { await c.query('ROLLBACK').catch(() => {}); c.release(); await pool.end().catch(() => {}); }

const report = buildDuplicateReport({ recommendations: recs, sites, draftCounts: counts });
const policies = [];
for (const s of sites.filter((x) => bareHost(x.website_domain))) {
  const samplePages = recs.filter((r) => Number(r.site_id) === Number(s.id)).map((r) => splitPageKey(r.page)?.url).filter((u) => u && new URL(u).pathname !== '/');
  policies.push({ siteId: Number(s.id), name: s.name, ...(await deriveSiteUrlPolicy({ domain: bareHost(s.website_domain), samplePages }, { fetchPage })) });
}
const plan = [];
for (const col of report.collisions) {
  const [a, b] = col.rows.map((r) => splitPageKey(r.original)?.url);
  const ev = col.level === 'safe' ? { equivalent: true, basis: 'safe-rules' } : await establishEquivalence(a, b, { fetchPage });
  const keep = col.rows.find((r) => r.id === col.keep); const fold = col.rows.filter((r) => r.id !== col.keep);
  plan.push({
    siteId: col.siteId, type: col.type, level: col.level, merge: ev.equivalent, basis: ev.basis || null, detail: ev.detail || null,
    keep: keep.id, foldIn: fold.map((r) => r.id), canonicalForm: ev.evidence?.finalA || ev.evidence?.finalB || keep.original,
    statements: ev.equivalent ? [
      `-- fold #${fold.map((r) => r.id).join(', #')} into #${keep.id} (${ev.basis})`,
      `UPDATE recommendations SET finding_ids = ARRAY(SELECT DISTINCT unnest(finding_ids || (SELECT array_agg(f) FROM recommendations x, unnest(x.finding_ids) f WHERE x.id IN (${fold.map((r) => r.id).join(',')})))), supporting_agents = ARRAY(SELECT DISTINCT s FROM unnest(supporting_agents || (SELECT array_agg(a) FROM recommendations x, unnest(x.detecting_agents || x.supporting_agents) a WHERE x.id IN (${fold.map((r) => r.id).join(',')}))) s WHERE s <> ALL(detecting_agents)) WHERE id = ${keep.id} AND status = 'open';`,
      `UPDATE recommendations SET status = 'superseded', updated_at = now() WHERE id IN (${fold.map((r) => r.id).join(',')}) AND status = 'open';`,
    ] : ['-- keep apart: no redirect or canonical evidence'],
  });
}
const out = { generatedAt: new Date().toISOString(), database: host, dryRun: true, totals: report.totals, policies, plan };
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`DRY RUN against ${host}: ${report.totals.open} open recommendations, ${report.collisions.length} collision group(s). Nothing was written.`);
  for (const p of policies) console.log(`site ${p.siteId} ${p.name}: www=${p.www} scheme=${p.scheme} trailingSlash=${p.trailingSlash}`);
  for (const p of plan) { console.log(`\nsite ${p.siteId} ${p.type} [${p.level}] ${p.merge ? `MERGE (${p.basis})` : 'KEEP APART'}: keep #${p.keep}, fold ${p.foldIn.map((i) => `#${i}`).join(', ')}; canonical ${p.canonicalForm}`); for (const s of p.statements) console.log(`  ${s}`); }
}
process.exit(0);
