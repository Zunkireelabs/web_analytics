// Dev tool: fill ONE project in the LOCAL dev database with sample history so every screen has something to show:
// 10 weeks of search and visit numbers (rising), top searches, a health score trend, a baseline report, two audits
// (for page scores), fixes that went live last week, and a saved content pick. Everything it adds is tagged so
// `--remove` takes it out again. It REFUSES to run unless DATABASE_URL points at this machine.
//   DATABASE_URL=postgres://...@localhost:55432/analytics DB_SSL=off node server/scripts/seed-local-demo.js --site 1 [--remove]
import { pool } from '../db.js';
import { saveContentPick } from '../store/content-picks.js';

const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1'].includes(host)) { console.error(`Refusing to run: DATABASE_URL host is "${host || 'unset'}", not this machine.`); process.exit(1); }
const i = process.argv.indexOf('--site');
const siteId = Number(process.argv[i + 1]);
if (!siteId) { console.error('Usage: --site <site id> [--remove]'); process.exit(1); }
const TAG = 'local-demo';
const q = (sql, p) => pool.query(sql, p);
const day = (offset) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

if (process.argv.includes('--remove')) {
  await q(`DELETE FROM drafts WHERE site_id=$1 AND finding_origin=$2`, [siteId, TAG]);
  await q(`DELETE FROM audit_runs WHERE id IN (SELECT audit_run_id FROM audit_page_findings WHERE site_id=$1 AND agent_id=$2)`, [siteId, TAG]); // findings go with them
  await q(`DELETE FROM baseline_reports WHERE site_id=$1`, [siteId]);
  await q(`DELETE FROM gsc_breakdown WHERE site_id=$1`, [siteId]);
  await q(`DELETE FROM gsc_daily WHERE site_id=$1`, [siteId]);
  await q(`DELETE FROM ga4_daily WHERE site_id=$1`, [siteId]);
  await q(`DELETE FROM daily_reports WHERE site_id=$1`, [siteId]);
  console.log('Removed the demo history for site', siteId);
  await pool.end(); process.exit(0);
}

const { rows: [site] } = await q('SELECT id, name FROM sites WHERE id=$1', [siteId]);
if (!site) { console.error(`No site ${siteId}`); process.exit(1); }

// Deterministic, rising numbers (about 15 clicks a day 10 weeks ago, about 55 now), a weekday dip, no randomness.
const N = 110;
const QUERIES = ['seo report for agencies', 'ai visibility tracker', 'automatic seo fixes', 'client seo reports', 'aeo optimization', 'schema markup checker'];
for (let k = N; k >= 1; k -= 1) {
  const date = day(-k);
  const t = (N - k) / N;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const wk = dow === 0 || dow === 6 ? 0.7 : 1;
  const clicks = Math.round((15 + 40 * t + 4 * Math.sin(k)) * wk);
  const impressions = Math.round(clicks * (30 + 6 * (1 - t)));
  const position = Number((14.2 - 5.5 * t).toFixed(1));
  await q(`INSERT INTO gsc_daily (site_id,date,clicks,impressions,ctr,position) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (site_id,date) DO UPDATE SET clicks=EXCLUDED.clicks, impressions=EXCLUDED.impressions, ctr=EXCLUDED.ctr, position=EXCLUDED.position`,
    [siteId, date, clicks, impressions, clicks / impressions, position]);
  const users = Math.round(clicks * 0.62);
  await q(`INSERT INTO ga4_daily (site_id,date,users,new_users,sessions,engaged_sessions,avg_engagement_time,conversions,bounce_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (site_id,date) DO UPDATE SET users=EXCLUDED.users, sessions=EXCLUDED.sessions`,
    [siteId, date, users, Math.round(users * 0.7), Math.round(users * 1.2), Math.round(users * 0.8), 52, 0, 0.41]);
  await q(`DELETE FROM gsc_breakdown WHERE site_id=$1 AND date=$2 AND dim_type='query'`, [siteId, date]);
  for (const [qi, text] of QUERIES.entries()) {
    // The first query keeps growing, the last one fades, so "biggest movers" has both directions.
    const share = qi === 0 ? 0.15 + 0.25 * t : qi === QUERIES.length - 1 ? 0.3 - 0.25 * t : 0.2 - qi * 0.02;
    const c = Math.max(0, Math.round(clicks * share));
    await q(`INSERT INTO gsc_breakdown (site_id,date,dim_type,dim_value,clicks,impressions,ctr,position) VALUES ($1,$2,'query',$3,$4,$5,$6,$7)`,
      [siteId, date, text, c, c * 25, 0.04, position]);
  }
  if (k % 7 === 0 || k === 1) {
    await q(`INSERT INTO daily_reports (site_id,date,website_health_score) VALUES ($1,$2,$3)
             ON CONFLICT (site_id,date) DO UPDATE SET website_health_score=EXCLUDED.website_health_score`,
      [siteId, date, Math.round(71 + 15 * t)]);
  }
}

// Baseline: frozen 45 days ago (a 30-day window, like the real one).
const baseAt = `${day(-45)}T09:00:00Z`;
await q(`DELETE FROM baseline_reports WHERE site_id=$1`, [siteId]);
await q(`INSERT INTO baseline_reports (site_id, generated_at, kpi_snapshot, issues_snapshot, narrative_md) VALUES ($1,$2,$3,$4,$5)`, [
  siteId, baseAt,
  JSON.stringify({ daysOfHistory: 30, clicks: 520, impressions: 16400, healthScore: 71, industry: 'SEO software' }),
  JSON.stringify({ auditFindings: { total: 38, pagesAffected: 12 }, openRecommendations: { total: 38 }, aiVisibility: { available: false } }),
  '## Where Your Website Stood\n\nWhen we first looked, the site was found for a handful of searches and had 38 things to fix across 12 pages. Every future report is compared with these numbers.\n',
]);

// Two audits so page scores can compare the same page then and now.
await q(`DELETE FROM audit_runs WHERE id IN (SELECT audit_run_id FROM audit_page_findings WHERE site_id=$1 AND agent_id=$2)`, [siteId, TAG]);
const mkRun = async (startedDaysAgo, health, by) => (await q(
  `INSERT INTO audit_runs (site_id,mode,triggered_by,status,started_at,finished_at,pages_discovered,pages_audited,health_score)
   VALUES ($1,'full',$2,'completed',$3,$3,12,12,$4) RETURNING id`, [siteId, by, `${day(-startedDaysAgo)}T09:00:00Z`, health])).rows[0].id;
const first = await mkRun(45, 71, 'onboarding'); const latest = await mkRun(2, 86, 'scheduled');
const pageUrls = ['/services', '/pricing', '/about', '/blog/seo-report-guide'];
const add = (run, page, n, priority) => Promise.all(Array.from({ length: n }, (_, j) => q(
  `INSERT INTO audit_page_findings (audit_run_id,site_id,agent_id,page,finding_id,priority) VALUES ($1,$2,$3,$4,$5,$6)`,
  [run, siteId, TAG, `https://example.com${page}`, `demo-${page}-${j}`, priority])));
for (const [p, before, now] of [[pageUrls[0], 4, 1], [pageUrls[1], 3, 2], [pageUrls[2], 2, 0], [pageUrls[3], 3, 1]]) { await add(first, p, before, 'high'); await add(latest, p, now, 'high'); }

// Fixes that went live in last week's Monday to Sunday, and a few earlier, so "what we did" has real rows.
await q(`DELETE FROM drafts WHERE site_id=$1 AND finding_origin=$2`, [siteId, TAG]);
const lastWeekDay = (() => { const d = new Date(); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow - 5); return d.toISOString().slice(0, 10); })();
const monthDay = day(-33);
for (const [type, n, at] of [['faq', 4, lastWeekDay], ['schema', 3, lastWeekDay], ['alt-text', 6, lastWeekDay], ['meta-title', 5, monthDay], ['faq', 2, monthDay]]) {
  // The source decides the signal family the fix is listed under (SEO / AEO / GEO), as for real fixes.
  const source = { faq: 'ai-visibility', schema: 'geo-signals' }[type] || 'technical-seo';
  for (let j = 0; j < n; j += 1) await q(`INSERT INTO drafts (site_id,action_type,source,finding_origin,input,content,status,implemented_at,created_at) VALUES ($1,$2,$3,$4,$5,'{}','implemented',$6,$6)`, [siteId, type, source, TAG, JSON.stringify({ page: ['/services', '/pricing', '/about', '/blog'][j % 4] }), `${at}T10:00:00Z`]);
}

// One saved content pick (approved on screen, built by the next daily run).
const { rows: [rec] } = await q(`SELECT finding_ids FROM recommendations WHERE site_id=$1 AND recommendation_type='blog-outline' AND status='open' ORDER BY id LIMIT 1`, [siteId]);
if (rec?.finding_ids?.[0]) await saveContentPick(siteId, { findingId: rec.finding_ids[0], generatorId: 'blog-outline', optionKey: 'B' });

console.log(`Demo history added for ${site.name} (id ${siteId}). Remove with --remove.`);
await pool.end();
