// SELF-REPAIR RUNNER. Every project, independently: gather that project's own facts (every query is scoped by site_id), run the pure detectors, store what
// is missing with the repair it proposes, and resolve what is no longer true. A project that errors is skipped with the error logged; the others still run.
//
// It never edits a client's configuration, repo or drafts. A proposal is applied by a person through the existing audited paths
// (scripts/apply-url-file-map-proposal.js: backup, dry-run, apply; Design Review). It runs inside the existing hourly alerts tick (no new scheduler).
// SELF_REPAIR_MODE: on (default; writes only its own table) | off.
import { detectCapabilityFindings, headingEvidenceFromProfile } from './detectors.js';

export const selfRepairMode = (env = process.env) => (String(env.SELF_REPAIR_MODE || 'on').toLowerCase() === 'off' ? 'off' : 'on');
const defaultQuery = async (...a) => (await import('../../db.js')).query(...a);
const tolerant = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } }; // a table a deploy has not created yet is "no facts", not a crash

/** One project's facts. Every statement carries `site_id = $1`: nothing here can read another project's rows. */
export async function gatherFacts(siteId, { query = defaultQuery, readContract = null, now = new Date() } = {}) {
  const { rows: [site] } = await query(`SELECT id, name, url_file_map, repo_owner, repo_name, growth_started_at FROM sites WHERE id = $1`, [siteId]);
  if (!site) return null;
  const count = async (sql) => Number((await query(sql, [siteId])).rows[0]?.n || 0);
  const openBlogRecs = await count(`SELECT count(*)::int n FROM recommendations WHERE site_id = $1 AND recommendation_type = 'blog-outline' AND status = 'open'`);
  const blogDrafts14d = await count(`SELECT count(*)::int n FROM drafts WHERE site_id = $1 AND action_type = 'blog-outline' AND created_at > now() - interval '14 days'`);
  const renderMismatchAbandoned = await count(`SELECT count(*)::int n FROM drafts WHERE site_id = $1 AND action_type = 'blog-outline' AND status = 'abandoned' AND abandoned_reason ILIKE '%measures differently%' AND created_at > now() - interval '30 days'`);
  const noArticlePageAbandoned = await count(`SELECT count(*)::int n FROM drafts WHERE site_id = $1 AND action_type = 'blog-outline' AND status = 'abandoned' AND abandoned_reason ILIKE '%No real "inline-article" page%' AND created_at > now() - interval '30 days'`);
  const blogRefusals = (await tolerant(() => query(
    `SELECT DISTINCT detail FROM generator_outcomes WHERE site_id = $1 AND generator_id = 'blog-outline' AND outcome = 'refused' AND created_at > now() - interval '14 days' LIMIT 20`, [siteId]), { rows: [] })).rows.map((r) => r.detail).filter(Boolean);
  const pendingPatterns = (await tolerant(() => query(
    `SELECT id, payload->>'pageType' AS "pageType", payload->>'generatorId' AS "generatorId", created_at AS "createdAt" FROM design_proposals WHERE site_id = $1 AND kind = 'new-page-pattern' AND status = 'pending'`, [siteId]), { rows: [] })).rows;
  const skippedBlogItems = (await tolerant(() => query(
    `SELECT updated_at::date::text AS day, skip_reason AS "skipReason", history->-1->>'reason' AS reason FROM delivery_items WHERE site_id = $1 AND generator_id = 'blog-outline' AND skip_reason IS NOT NULL AND updated_at > now() - interval '5 days'`, [siteId]), { rows: [] })).rows;
  const gaps = await count(`SELECT count(*)::int n FROM keyword_gaps WHERE site_id = $1`);
  const lastRun = (await tolerant(() => query(`SELECT max(checked_at) AS at FROM keyword_demand_runs WHERE site_id = $1`, [siteId]), { rows: [{}] })).rows[0]?.at || null;
  const discovery = (await tolerant(() => query(`SELECT path, status, reason_code AS "reasonCode", message, checked_at AS "checkedAt" FROM keyword_discovery_status WHERE site_id = $1`, [siteId]), { rows: [] })).rows;
  const blockedPaths = discovery.filter((d) => d.status === 'blocked' || d.status === 'skipped');
  const skipReason = blockedPaths.length ? blockedPaths.map((d) => `${d.path}: ${d.message}`).join(' | ') : null;

  // The project's own sibling posts, only when a front-matter refusal makes it worth the repo read.
  let siblingConstants = {}; let siblingsSampled = 0; let requiredKeys = [];
  const blog = site.url_file_map?.newContentTargets?.['blog-outline'];
  if (readContract && blog?.dir && blogRefusals.some((t) => /Every existing post in this directory declares/.test(t))) {
    const c = await tolerant(() => readContract(site, { dir: blog.dir, extension: blog.extension || '.md' }), null);
    if (c && !c.unknown) { siblingConstants = c.siblingConstants || {}; siblingsSampled = c.sampled || 0; requiredKeys = c.requiredKeys || []; }
  }
  return { site, openBlogRecs, blogDrafts14d, renderMismatchAbandoned, noArticlePageAbandoned, blogRefusals, pendingPatterns, skippedBlogItems, siblingConstants, siblingsSampled, requiredKeys, headingEvidence: headingEvidenceFromProfile(site.url_file_map?.siteRoot?.designProfile), keyword: { gaps, lastRunAt: lastRun, skipReason, blockedPaths, paths: discovery.map((d) => ({ path: d.path, status: d.status })) }, now };
}

/** Store this project's findings; resolve the ones no longer detected. Returns { open, resolved }. */
export async function storeFindings(siteId, findings, { query = defaultQuery } = {}) {
  const keys = [];
  for (const f of findings) {
    keys.push(`${f.kind}\u0000${f.subject}`);
    await query(
      `INSERT INTO capability_findings (site_id, kind, subject, status, severity, summary, evidence, proposal, blocker)
       VALUES ($1, $2, $3, 'open', $4, $5, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (site_id, kind, subject) DO UPDATE SET status = 'open', severity = EXCLUDED.severity, summary = EXCLUDED.summary, evidence = EXCLUDED.evidence,
         proposal = EXCLUDED.proposal, blocker = EXCLUDED.blocker, last_seen = now(), resolved_at = NULL`,
      [siteId, f.kind, f.subject, f.severity, f.summary, JSON.stringify(f.evidence || {}), f.proposal ? JSON.stringify(f.proposal) : null, f.blocker]);
  }
  const { rows } = await query(`SELECT kind, subject FROM capability_findings WHERE site_id = $1 AND status = 'open'`, [siteId]);
  let resolved = 0;
  for (const r of rows) {
    if (keys.includes(`${r.kind}\u0000${r.subject}`)) continue;
    await query(`UPDATE capability_findings SET status = 'resolved', resolved_at = now() WHERE site_id = $1 AND kind = $2 AND subject = $3 AND status = 'open'`, [siteId, r.kind, r.subject]);
    resolved++;
  }
  return { open: findings.length, resolved };
}

// SAFE REPAIRS THE SYSTEM CAN CARRY OUT ITSELF. Only a finding whose proposal says `safe` and names one of these actions is executed, only for its own project, and
// only when SELF_REPAIR_ACT=on (default off: restoring a draft writes production data, so a person turns it on). Everything else stays a proposal.
const ACTIONS = {
  'rerender-abandoned-drafts': async (siteId, deps) => {
    const { rerenderAbandonedBlogDrafts } = await import('./rerender-blog-drafts.js');
    const real = deps.rerenderDeps || {
      getSite: (await import('../../store/read.js')).getSiteById,
      resolveTargetAndBody: (await import('../../implementers/frontend.js')).resolveTargetAndBody,
      validateRendering: (await import('../../implementers/lib/rendering-gate.js')).validateRendering,
    };
    return rerenderAbandonedBlogDrafts(siteId, { apply: true, query: deps.query, ...real });
  },
};
// Re-derives ONE project's design profile (its own live pages, a real browser) through the existing design-agent queue: how a blog-article layout that was never
// observed (posts kept at the site root) gets observed, which resolves the pending layout proposal. Queues a job only; it writes no client config.
ACTIONS['rederive-design-profile'] = async (siteId, deps) => {
  const getSite = deps.getSite || (await import('../../store/read.js')).getSiteById;
  const rescan = deps.rescan || (await import('../../job.js')).queueDesignProfileRescanForSite;
  const site = await getSite(siteId);
  const queued = await rescan(site, { force: true });
  return { queued: Boolean(queued) };
};
export async function actOnFindings(siteId, findings, deps = {}) {
  const { selfRepairActMode } = await import('./rerender-blog-drafts.js');
  const done = [];
  if (selfRepairActMode(deps.env) !== 'on') return done;
  for (const f of findings) {
    const run = f.proposal?.safe === true ? (deps.actions || ACTIONS)[f.proposal.action] : null;
    if (!run) continue;
    try { const r = await run(siteId, deps); done.push({ kind: f.kind, action: f.proposal.action, result: { restored: r?.restored, stillFailing: r?.stillFailing, queued: r?.queued } }); }
    catch (err) { done.push({ kind: f.kind, action: f.proposal.action, error: err.message }); }
  }
  return done;
}

export async function runSelfRepairForSite(siteId, deps = {}) {
  const facts = await gatherFacts(siteId, deps);
  if (!facts) return { siteId, skipped: 'no-such-project' };
  const findings = detectCapabilityFindings(facts, { now: deps.now || new Date() });
  const stored = await storeFindings(siteId, findings, deps);
  const acted = await actOnFindings(siteId, findings, deps);
  return { siteId, ...stored, kinds: findings.map((f) => f.kind), acted };
}

/** Every project, each in its own try: one project's failure never stops another's check. */
export async function runSelfRepairForAllSites({ sites, log = console, ...deps } = {}) {
  if (selfRepairMode() === 'off') return [];
  const list = sites || (await (deps.query || defaultQuery)(`SELECT id FROM sites WHERE repo_owner IS NOT NULL AND repo_name IS NOT NULL ORDER BY id`)).rows;
  const out = [];
  for (const s of list) {
    try { out.push(await runSelfRepairForSite(s.id, deps)); }
    catch (err) { log.error?.(`[self-repair] site ${s.id} failed: ${err.message}`); out.push({ siteId: s.id, error: err.message }); }
  }
  const open = out.reduce((n, r) => n + (r.open || 0), 0);
  if (open) log.log?.(`[self-repair] ${open} open finding(s) across ${out.length} project(s): ${out.filter((r) => r.open).map((r) => `${r.siteId}:${r.kinds.join('+')}`).join(' ')}`);
  return out;
}

export async function listOpenFindings(siteId = null, { query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT site_id, kind, subject, severity, summary, evidence, proposal, blocker, first_seen, last_seen FROM capability_findings
      WHERE status = 'open' ${siteId == null ? '' : 'AND site_id = $1'} ORDER BY site_id, severity, kind`, siteId == null ? [] : [siteId]);
  return rows;
}
