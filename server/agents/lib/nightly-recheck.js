// THE NIGHTLY RE-CHECK (owner's rule, 2026-11-19): every night the agent re-reads the live page behind every open issue, so an
// issue fixed yesterday is closed today and tomorrow's list holds only new problems. Before this, an open issue was only
// re-checked when its page happened to win one of at most half a rotation batch (about 10 pages per agent per night, always the
// same first ones), so the 11th open issue of an agent was never re-checked while the first 10 stayed open.
//
// Rules that keep it safe:
//  - It closes an issue only on direct evidence: the agent re-read THAT page this run and no longer reports the finding. If the
//    agent says which pages it checked and this page is not among them (page unreachable, skipped, a crawl error), the issue
//    stays open and is counted as "not verified". Silence from a failed fetch is never taken as "fixed".
//  - Site-wide issues, and issues raised by whole-site scans with no per-page agent, are left to their own full runs.
//  - Oldest-checked first, capped per project per night, so a large backlog is worked through over several nights.

export const MAX_PAGES_PER_AGENT_RUN = 20;
export const MAX_RECHECKS_PER_SITE = 200;

/**
 * Pure. Decide what one open recommendation's re-check means.
 *   output   the agent's result for the pages it was given ({ facts: { findings, checkedPages? } })
 *   keyOf    finding -> the page key it would be stored under
 * Returns 'still-present' | 'fixed' | 'unverified'.
 */
export function decideRecheck(rec, output, keyOf) {
  // An agent that did not complete normally ('insufficient-data', 'skipped', 'error') has no findings because it found nothing out,
  // not because there is nothing to find. Its silence is never evidence that an issue is fixed.
  if (output?.status && output.status !== 'ok') return 'unverified';
  const findings = output?.facts?.findings;
  if (!Array.isArray(findings)) return 'unverified';
  const present = findings.some((f) => f.recommendedAction?.generatorId === rec.recommendation_type && keyOf(f) === rec.page);
  if (present) return 'still-present';
  const checked = output.facts.checkedPages;
  if (rec.page && Array.isArray(checked) && !checked.some((p) => samePage(p, rec.page))) return 'unverified';
  return 'fixed';
}

// Compared by path (a stored page may be a full address or a bare path); the project is already fixed by the query.
const norm = (u) => (String(u || '').replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '') || '/').toLowerCase();
const samePage = (a, b) => norm(a) === norm(b);

/** Pure. Oldest-checked first, then split into per-agent groups of at most `size` pages. */
export function planRechecks(rows, { limit = MAX_RECHECKS_PER_SITE, size = MAX_PAGES_PER_AGENT_RUN } = {}) {
  const ordered = [...rows].sort((a, b) => (a.last_rechecked_at ? new Date(a.last_rechecked_at).getTime() : 0) - (b.last_rechecked_at ? new Date(b.last_rechecked_at).getTime() : 0) || a.id - b.id).slice(0, limit);
  const links = ordered.filter((r) => r.recommendation_type === 'broken-link-fix' && r.page);
  const byAgent = new Map();
  const siteLevel = new Map();
  for (const r of ordered) {
    if (!r.page && r.recommendation_type !== 'broken-link-fix' && r.detecting_agents?.[0]) {
      const a = r.detecting_agents[0];
      if (!siteLevel.has(a)) siteLevel.set(a, []);
      siteLevel.get(a).push(r);
      continue;
    }
    if (!r.page) continue;
    if (r.recommendation_type === 'broken-link-fix') continue;
    const agent = r.detecting_agents?.[0];
    if (!agent) continue;
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(r);
  }
  const groups = [];
  for (const [agent, recs] of byAgent) for (let i = 0; i < recs.length; i += size) groups.push({ agent, recs: recs.slice(i, i + size) });
  // A site-wide issue is checked by running its agent over the whole site once (no page list).
  for (const [agent, recs] of siteLevel) groups.push({ agent, recs, siteWide: true });
  return { links, groups };
}

/** One project. Never throws; returns counts. `deps` lets tests run it without a database or live site. */
export async function recheckOpenIssuesForSite(siteId, { deps = {}, deadlineAt = null } = {}) {
  const query = deps.query || (await import('../../db.js')).query;
  const { getSiteById } = deps.getSiteById ? deps : await import('../../store/read.js');
  const { daysAgoInTz } = await import('../../util/dates.js');
  const coord = deps.coord || (await import('./recommendation-coordinator.js'));
  const runAgent = deps.runAgent || (await import('../runner.js')).runAgent;
  const recheckLink = deps.recheckLink || (await import('./technical-seo-analysis.js')).recheckLink;
  const close = deps.close || (await import('../../store/recommendations.js')).closeRecommendation;
  const keyOf = (f) => coord.recommendationPageKey({ generatorId: f.recommendedAction.generatorId, params: f.recommendedAction.params });
  const out = { siteId, checked: 0, fixed: 0, stillOpen: 0, unverified: 0, notCheckable: 0, errors: 0, deadlineHit: false };
  const now = deps.now || Date.now;
  const pastDeadline = () => deadlineAt != null && now() >= deadlineAt;

  const { rows } = await query(
    `SELECT id, page, recommendation_type, detecting_agents, params, last_rechecked_at FROM recommendations
      WHERE site_id = $1 AND status = 'open'`, [siteId]);
  const { links, groups } = planRechecks(rows);
  const touch = (ids) => ids.length ? query(`UPDATE recommendations SET last_rechecked_at = now() WHERE site_id = $1 AND id = ANY($2::int[])`, [siteId, ids]) : null;
  const site = await (deps.getSiteById || getSiteById)(siteId);
  const tz = site?.timezone || 'UTC';

  for (const r of links) {
    if (pastDeadline()) { out.deadlineHit = true; break; }
    try {
      if (!r.params?.href) { out.unverified++; continue; }
      const res = await recheckLink(r.params.href);
      out.checked++;
      if (!res.broken) { await close(r.id); out.fixed++; } else out.stillOpen++;
      await touch([r.id]);
    } catch (err) { out.errors++; console.warn(`[nightly-recheck] site ${siteId}: link re-check failed: ${String(err?.message || err).slice(0, 200)}`); }
  }
  const providerFailures = deps.providerFailureCount || (await import('../../lib/provider-health.js')).providerFailureCount;
  out.degraded = 0;
  for (const g of groups) {
    // Stops BETWEEN groups, never inside one: what was not reached keeps its old last_rechecked_at and is first in line tomorrow.
    if (pastDeadline()) { out.deadlineHit = true; break; }
    try {
      const failuresBefore = providerFailures();
      const output = await runAgent(g.agent, { siteId, start: daysAgoInTz(tz, 28), end: daysAgoInTz(tz, 0), ...(g.siteWide ? {} : { params: { pages: g.recs.map((r) => r.page) } }) }, { persist: false });
      // A model call failed because the provider was unavailable while this agent ran (out of credit, outage). Part of what the agent
      // would have reported (anything it asks the model for) may be missing, so "no finding" proves nothing tonight: keep every
      // issue it covers open and look again tomorrow. Issues it still sees are still counted as still present.
      const degraded = providerFailures() > failuresBefore;
      const touched = [];
      for (const r of g.recs) {
        let verdict = decideRecheck(r, output, keyOf);
        if (verdict === 'fixed' && degraded) { verdict = 'unverified'; out.degraded++; }
        if (verdict === 'fixed') { await close(r.id); out.fixed++; out.checked++; }
        else if (verdict === 'still-present') { out.stillOpen++; out.checked++; touched.push(r.id); }
        else out.unverified++;
      }
      await touch(touched);
    } catch (err) {
      // Leave its issues exactly as they are. An agent the runner does not know (growth-opportunities, faq-onboarding-check, ... raise
      // issues but have no page re-check) is not a failure: count it as "not checkable", not as an error. A real failure keeps its reason.
      if (/^Unknown agent /.test(err?.message || '')) out.notCheckable += g.recs.length;
      else { out.errors++; console.warn(`[nightly-recheck] site ${siteId}: agent ${g.agent} failed: ${String(err?.message || err).slice(0, 200)}`); }
    }
  }
  return out;
}

// ── Ideas and opportunities: not about one live page, so "fixed" means something else ─────────────────────────────────────────
// Blog ideas (ai-recommendation, keyword-narrative, trend-radar, content-gap topics) are satisfied when the site now has a page
// that covers the topic. Judged by the deterministic coverage check only (no model call); a person's own request is never closed.
export const IDEA_AGENTS = ['ai-recommendation', 'keyword-narrative', 'trend-radar', 'news-posts', 'analyst-keyword-gaps'];
export const MAX_IDEA_CHECKS_PER_SITE = 40;

export async function closeSatisfiedIdeasForSite(siteId, { deps = {} } = {}) {
  const query = deps.query || (await import('../../db.js')).query;
  const classify = deps.classify || (await import('./keyword-coverage-service.js')).classifyGapCoverage;
  const close = deps.close || (await import('../../store/recommendations.js')).closeRecommendation;
  const { rows } = await query(
    `SELECT id, params FROM recommendations
      WHERE site_id = $1 AND status = 'open' AND recommendation_type = 'blog-outline' AND detecting_agents && $2::text[]
        AND COALESCE(params->>'clientRequested','') <> 'true' AND params->>'topic' IS NOT NULL
      ORDER BY last_rechecked_at NULLS FIRST, id LIMIT $3`, [siteId, IDEA_AGENTS, MAX_IDEA_CHECKS_PER_SITE]);
  const out = { checked: 0, closed: 0, errors: 0 };
  for (const r of rows) {
    try {
      const v = await classify(siteId, { topic: r.params.topic }, { allowLLM: false, persist: false });
      out.checked++;
      if (['covered', 'duplicate'].includes(v?.status) && v.url) { await close(r.id); out.closed++; }
      else await query('UPDATE recommendations SET last_rechecked_at = now() WHERE id = $1 AND site_id = $2', [r.id, siteId]);
    } catch { out.errors++; }
  }
  return out;
}

// Growth opportunities: the detector (analyst-seo-mapping.js syncGrowthOpportunitiesToActionCenter) re-derives them from Search
// Console every run. One it no longer reports has stopped being an opportunity (the query moved, the page improved), so it is
// closed. Guarded: only with fresh Search Console data (a data outage must never empty the list), and never a row that already has
// a draft in flight.
export async function closeUnreportedOpportunities(siteId, reportedKeys, { deps = {} } = {}) {
  const query = deps.query || (await import('../../db.js')).query;
  const close = deps.close || (await import('../../store/recommendations.js')).closeRecommendation;
  const { rows: [fresh] } = await query(
    `SELECT GREATEST((SELECT max(date) FROM gsc_daily WHERE site_id = $1), (SELECT max(date) FROM gsc_screen_daily WHERE site_id = $1)) >= current_date - 7 AS ok`, [siteId]).catch(() => ({ rows: [{ ok: false }] }));
  if (!fresh?.ok) return { closed: 0, skipped: 'no fresh Search Console data' };
  const { rows } = await query(
    `SELECT r.id, r.page, r.recommendation_type FROM recommendations r
      WHERE r.site_id = $1 AND r.status = 'open' AND r.detecting_agents = ARRAY['growth-opportunities']::text[]
        AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.site_id = r.site_id AND d.finding_id = ANY(r.finding_ids) AND d.status NOT IN ('abandoned','implemented','merged_to_stage'))`, [siteId]);
  let closed = 0;
  for (const r of rows) if (!reportedKeys.has(`${r.recommendation_type}::${r.page}`)) { await close(r.id); closed++; }
  return { closed };
}
