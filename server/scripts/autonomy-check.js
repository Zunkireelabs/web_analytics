import { query as dbQuery } from '../db.js';
import { getSiteById } from '../store/read.js';
import { assessTenantReadiness } from '../lib/tenant-provisioning.js';
import { callDataAnalystAgent } from '../lib/data-analyst-client.js';
import { designCaptureNeedsPerson } from '../implementers/lib/onboarding-readiness.js';

// "Will this client run on its own?" One answer per stage of the loop, with the exact reason when not.
//
//   node server/scripts/autonomy-check.js <siteId>          read-only: this database + the analyst service
//   node server/scripts/autonomy-check.js <siteId> --live    also asks Search Console whether a sitemap is registered
//
// Exit code 0 = every stage is green, 1 = something would stop it. Nothing is written anywhere.
//
// Status: ok (green), fail (stops the loop), warn (works, but not at full strength), unknown (could not be read).

const DAY = 24 * 60 * 60 * 1000;
const days = (iso, now) => (iso ? Math.floor((now - Date.parse(iso)) / DAY) : null);

// ---- pure: facts in, verdicts out (this is what the tests cover) ----
export function evaluateAutonomy(f, now = Date.now()) {
  const stages = [];
  const add = (stage, name, status, detail, fix = null) => stages.push({ stage, name, status, detail, ...(fix ? { fix } : {}) });

  // 1. Connect
  add('1 Connect', 'Search Console + GA4 saved', f.site.gsc && f.site.ga4 ? 'ok' : 'fail',
    f.site.gsc && f.site.ga4 ? `${f.site.gsc} / GA4 ${f.site.ga4}` : 'no property pair saved', 'connect Google in Add project');
  if (f.google.mode === 'own') {
    add('1 Connect', 'Google sign-in still valid', f.google.status === 'active' || f.google.status == null ? 'ok' : 'fail',
      `status: ${f.google.status || 'active'}${f.google.error ? ` (${f.google.error})` : ''}`, 'the client reconnects Google');
  } else {
    add('1 Connect', 'Google credential', 'warn', 'using the shared SuperRank Google account, not the client\'s own');
  }
  if (f.sitemap) add('1 Connect', 'Sitemap registered in Search Console',
    f.sitemap.status === 'registered' ? 'ok' : f.sitemap.status === 'unknown' ? 'unknown' : 'fail',
    f.sitemap.detail, 'runs automatically on the next site discovery; or check the site has a /sitemap.xml');

  // 2. Ingest
  const age = days(f.data.gscAsOf, now);
  add('2 Ingest', 'Search Console data is fresh', age == null ? 'fail' : age <= 3 ? 'ok' : 'fail',
    age == null ? 'no data at all' : `latest day ${f.data.gscAsOf} (${age} day(s) old)`, 'check the daily job and the Google connection');

  // 3. Detect
  const total = f.agents.ok + f.agents.insufficient + f.agents.error;
  const runAge = days(f.agents.lastRunAt, now);
  add('3 Detect', 'Detection agents ran recently', total === 0 ? 'fail' : runAge <= 2 ? 'ok' : 'fail',
    total === 0 ? 'no agent has run' : `${f.agents.ok} ok, ${f.agents.insufficient} had too little data, ${f.agents.error} errored; last run ${runAge} day(s) ago`, 'run the baseline or check the 07:00 job');
  if (f.agents.error) add('3 Detect', 'No agent errors', 'fail', `${f.agents.error} agent(s) errored in their latest run`, 'see agent_runs.error');

  // 4. Fix prerequisites (from the readiness check, minus what is reported elsewhere)
  for (const i of f.readiness.items) {
    if (i.key === 'analyst') continue; // reported under Platform
    add('4 Prepare', i.label, i.ok === true ? 'ok' : i.ok === false ? 'fail' : 'unknown', i.detail, i.fix);
  }
  add('4 Prepare', 'Design profile (shipping waits for it)', f.design.usable ? 'ok' : f.design.needsPerson ? 'fail' : 'warn',
    f.design.usable ? 'captured' : f.design.needsPerson ? 'capture failed every allowed try — shipping is held for a person' : `not captured yet (job: ${f.design.jobStatus || 'none'}) — shipping is held until it is`,
    'check the Design Agent worker, then ask for a new capture');
  add('4 Prepare', 'Shared layout file mapped', f.site.layoutTemplate ? 'ok' : 'warn',
    f.site.layoutTemplate || 'not mapped — sitewide fixes (viewport, html lang, analytics) cannot ship', 'derived automatically on repo connect; otherwise set siteRoot.layoutTemplate');

  // 5. Decide + Ship
  add('5 Ship', 'Autonomous fixes switched on', f.site.autoRemediation ? 'ok' : 'fail', f.site.autoRemediation ? `up to ${f.site.dailyLimit ?? 'the default'} a day` : 'off — nothing ships', 'switch on autonomous remediation for the project');
  add('5 Ship', 'Open recommendations to work from', f.recommendations.open > 0 ? 'ok' : 'warn',
    `${f.recommendations.open} open, ${f.recommendations.blocked} blocked`, f.recommendations.blocked ? 'the blocked ones show why in the Action Center' : null);
  if (f.ship.last) {
    const stopped = f.ship.last.stopped_reason;
    const bad = stopped && !['disabled'].includes(stopped);
    add('5 Ship', 'Latest shipping run', bad ? 'fail' : 'ok',
      `${days(f.ship.last.created_at, now)} day(s) ago: shipped ${f.ship.last.shipped}, failed ${f.ship.last.failed}${stopped ? `, stopped: ${stopped}` : ''}${f.ship.last.pr_url ? `, PR ${f.ship.last.pr_url}` : ''}`,
      stopped === 'onboarding-analysis-pending' ? 'waiting for the design capture' : null);
  } else add('5 Ship', 'Latest shipping run', 'warn', 'no shipping run recorded yet');

  // 6. Verify and learn
  add('6 Verify', 'Merged fixes are re-checked on the live site', f.verify.total > 0 ? 'ok' : 'unknown',
    f.verify.total > 0 ? `${f.verify.total} verification(s) recorded` : 'none yet (nothing has been merged and re-checked)');

  // Platform services every client depends on
  add('Platform', 'Data Analyst service', f.analyst.reachable ? 'ok' : 'fail', f.analyst.reachable ? 'reachable' : 'unreachable — no forecasts or anomaly checks for anyone', 'start / fix the data-analyst-agent service');
  add('Platform', 'This client is registered with the analyst', f.analyst.registered === true ? 'ok' : f.analyst.registered === false ? 'fail' : 'unknown',
    f.analyst.registered === true ? 'registered' : f.analyst.registered === false ? 'not registered (the nightly sync registers it once the service is up)' : 'could not check');
  add('Platform', 'Design Agent worker is processing jobs', f.design.workerSeen ? 'ok' : 'warn',
    f.design.workerSeen ? 'a design job has completed' : 'no completed design job on record — cannot tell whether the worker and browser run');

  const failing = stages.filter((s) => s.status === 'fail');
  return { stages, failing, ready: failing.length === 0 };
}

// ---- gathering the facts (read-only) ----
const soft = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

export async function gatherFacts(site, { query = dbQuery, live = false, analyst = callDataAnalystAgent, listSitemaps = null } = {}) {
  const id = site.id;
  const one = async (sql, params = [id]) => (await query(sql, params)).rows[0] || null;
  const many = async (sql, params = [id]) => (await query(sql, params)).rows;

  const gsc = await soft(() => one('SELECT MAX(date)::text AS as_of FROM gsc_daily WHERE site_id = $1'), null);
  const agentRows = await soft(() => many(`SELECT DISTINCT ON (agent_id) agent_id, status, created_at, error FROM agent_runs WHERE site_id = $1 ORDER BY agent_id, created_at DESC`), []);
  const conn = await soft(() => one('SELECT status, status_error FROM project_google_connections WHERE site_id = $1'), null);
  const recs = await soft(() => many(`SELECT (blocked_reason IS NOT NULL) AS blocked, count(*)::int AS n FROM recommendations WHERE site_id = $1 AND status = 'open' GROUP BY 1`), []);
  const lastShip = await soft(() => one('SELECT * FROM auto_remediation_runs WHERE site_id = $1 ORDER BY id DESC LIMIT 1'), null);
  const verifs = await soft(() => one('SELECT count(*)::int AS n FROM fix_verifications WHERE site_id = $1'), { n: 0 });
  const designJob = await soft(() => one(`SELECT status FROM execution_jobs WHERE site_id = $1 AND kind = 'design_generate' ORDER BY id DESC LIMIT 1`), null);
  const workerSeen = await soft(() => one(`SELECT 1 AS seen FROM execution_jobs WHERE kind = 'design_generate' AND status = 'completed' LIMIT 1`), null);
  const readiness = await assessTenantReadiness(site, { query });

  let analystState = { reachable: false, registered: null };
  try { await analyst(`/admin/clients/by-site/${id}`); analystState = { reachable: true, registered: true }; }
  catch (e) { analystState = e?.status === 404 ? { reachable: true, registered: false } : { reachable: false, registered: null }; }

  let sitemap = null;
  if (live) {
    const list = listSitemaps || (await import('../ingest/gsc-technical.js')).listSitemaps;
    const r = await soft(() => list(site), { ok: false });
    sitemap = r.ok ? (r.sitemaps.length ? { status: 'registered', detail: r.sitemaps.map((s) => s.path).join(', ') } : { status: 'missing', detail: 'none registered' }) : { status: 'unknown', detail: 'Search Console could not be read' };
  }

  const siteRoot = site.url_file_map?.siteRoot || {};
  const needsPerson = await soft(() => designCaptureNeedsPerson(site), false);
  const count = (b) => recs.filter((r) => Boolean(r.blocked) === b).reduce((n, r) => n + r.n, 0);
  return {
    site: { gsc: site.gsc_property, ga4: site.ga4_property_id, layoutTemplate: siteRoot.layoutTemplate || null, autoRemediation: Boolean(site.auto_remediation_enabled), dailyLimit: site.auto_remediation_daily_limit ?? null },
    google: { mode: conn ? 'own' : 'shared', status: conn?.status || null, error: conn?.status_error || null },
    sitemap, data: { gscAsOf: gsc?.as_of || null },
    agents: {
      ok: agentRows.filter((r) => r.status === 'ok').length, insufficient: agentRows.filter((r) => r.status === 'insufficient-data').length,
      error: agentRows.filter((r) => r.status === 'error').length, lastRunAt: agentRows.map((r) => r.created_at).sort().pop() || null,
    },
    readiness, recommendations: { open: count(false), blocked: count(true) }, ship: { last: lastShip }, verify: { total: verifs?.n || 0 },
    design: { usable: Boolean(siteRoot.designProfile), needsPerson, jobStatus: designJob?.status || null, workerSeen: Boolean(workerSeen) },
    analyst: analystState,
  };
}

const ICON = { ok: '✔', fail: '✘', warn: '!', unknown: '?' };
export function renderReport(site, verdict) {
  const out = [`\nAutonomy check — site ${site.id} "${site.name}"\n`];
  let last = '';
  for (const s of verdict.stages) {
    if (s.stage !== last) { out.push(`\n${s.stage}`); last = s.stage; }
    out.push(`  ${ICON[s.status]} ${s.name}: ${s.detail}${s.status !== 'ok' && s.fix ? `\n      → ${s.fix}` : ''}`);
  }
  out.push(`\n${verdict.ready ? 'READY: every stage is green.' : `NOT READY: ${verdict.failing.length} stage(s) would stop it:\n${verdict.failing.map((s) => `   - ${s.name}`).join('\n')}`}\n`);
  return out.join('\n');
}

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id)) { console.error('usage: node server/scripts/autonomy-check.js <siteId> [--live]'); process.exit(2); }
  const site = await getSiteById(id);
  if (!site) { console.error(`no site ${id}`); process.exit(2); }
  const facts = await gatherFacts(site, { live: process.argv.includes('--live') });
  const verdict = evaluateAutonomy(facts);
  console.log(renderReport(site, verdict));
  process.exit(verdict.ready ? 0 : 1);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(2); });
