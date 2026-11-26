// CONTINUOUS TOPIC RESEARCH (Phase 7). Keeps a READY POOL of evidence-accepted blog topics per project, at least as large as the next cycle needs, and
// never stops because the backlog is empty: it reads what the existing research agents produced (keyword demand and gaps, trend radar, competitor
// footprint, content gap), derives rising and predicted topics from the project's own Search Console history, runs every candidate through the SAME
// evidence gate the shipping loop uses (client-specific business relevance, no duplicate, no cannibalisation, real evidence), logs every decision
// with its reasons and the alternatives turned down, and proposes at most a capped number of topics per cycle. NOTHING is manufactured to meet a
// quota: if no candidate passes, nothing is proposed and the run says so in the decision log.
//
// TOPIC_RESEARCH: 'off' | 'log' (default: everything is decided and logged, no recommendation is created) | 'on' (accepted topics become real blog
// recommendations through the standard creator). Proposals only ever enter the normal path: the shipping loop still gates them again, a person
// still reviews and merges the pull request.
import { evaluateTopic } from '../blog-cycle/evidence-gate.js';
import { blogCycleCeiling } from '../blog-cycle/ceiling.js';

import { mergeCandidates, risingQueries, seasonalLift } from './signals.js';

export const topicResearchMode = (env = process.env) => { const v = String(env.TOPIC_RESEARCH || 'log').toLowerCase(); return ['off', 'log', 'on'].includes(v) ? v : 'log'; };
export const poolTarget = (env = process.env) => Math.max(blogCycleCeiling(env), Number(env.BLOG_POOL_TARGET) || 0);
export const maxProposalsPerCycle = (env = process.env) => { const n = Number(env.BLOG_RESEARCH_MAX_PROPOSALS ?? 8); return Number.isInteger(n) && n >= 1 ? Math.min(n, 30) : 8; };
export const MAX_CANDIDATES_JUDGED = 40;

async function defaultDeps() {
  const [st, ci, rel, gather, log, ne] = await Promise.all([
    import('./store.js'), import('../content-index/store.js'), import('../blog-cycle/relevance.js'), import('../blog-cycle/gather.js'), import('./decision-log.js'), import('../content-index/check.js'),
  ]);
  return {
    loadSeries: st.loadQuerySeries, loadMonthly: st.loadMonthlyTotals, loadBestPages: st.loadBestPages, loadGaps: st.loadOpenGaps, loadOpenTopics: st.loadOpenBlogTopics,
    poolCount: st.readyPoolCount, recentProposals: st.recentProposalCount, createProposal: st.createProposal,
    getIndex: (siteId) => ci.getFreshContentIndex(siteId), judge: (siteId, topics) => rel.judgeRelevance(siteId, topics), recentRelevance: log.recentRelevanceVerdicts,
    gather: (siteId, rec, topic) => gather.gatherTopicEvidence(siteId, rec, topic), checkIndex: ne.checkTopicAgainstIndex, record: log.recordTopicDecision,
    setDecisionRec: async (siteId, decisionId, recId) => { const { query } = await import('../../db.js'); await query('UPDATE topic_decisions SET recommendation_id = $3 WHERE site_id = $1 AND id = $2', [siteId, decisionId, recId]); },
  };
}

const endOfLastWeek = (now) => { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7); return d.toISOString().slice(0, 10); };

/**
 * One project, one run. Never throws (returns { error }). Safe to call as often as wanted: a full pool costs two cheap reads and nothing else.
 */
export async function runTopicResearchForSite(site, { mode = topicResearchMode(), deps = null, now = new Date(), log = console.log } = {}) {
  const out = { siteId: site.id, mode, pool: null, target: null, need: null, candidates: 0, accepted: 0, proposed: 0, rejected: 0, deferred: 0, skipped: null };
  if (mode === 'off') return { ...out, skipped: 'off' };
  try {
    const d = { ...(await defaultDeps()), ...(deps || {}) };
    const tz = site.timezone || undefined;
    const cap = maxProposalsPerCycle(); const target = poolTarget();
    out.pool = await d.poolCount(site.id); out.target = target; out.need = Math.max(0, target - out.pool);
    if (out.need === 0) {
      await d.record(site.id, { topic: `(research run ${now.toISOString().slice(0, 10)})`, decision: 'deferred', origin: 'research-run', evidence: { poolFull: true, pool: out.pool, target }, enforced: mode === 'on' }, { dedupeToday: true, now, timezone: tz }).catch(() => null);
      return { ...out, skipped: 'pool-full' };
    }

    // 1. real data
    const endWeek = endOfLastWeek(now);
    const [series, bestPages, gaps, openTopics, monthly] = await Promise.all([d.loadSeries(site.id), d.loadBestPages(site.id), d.loadGaps(site.id), d.loadOpenTopics(site.id), d.loadMonthly(site.id).catch(() => ({}))]);
    const seasonal = seasonalLift(monthly, now.getUTCMonth() + 1);
    const rising = risingQueries(series, { bestPageByQuery: bestPages, site, endWeek });
    const candidates = mergeCandidates({ rising, gaps, openTopics, seasonal }).slice(0, MAX_CANDIDATES_JUDGED);
    out.candidates = candidates.length;
    if (!candidates.length) {
      await d.record(site.id, { topic: `(research run ${now.toISOString().slice(0, 10)})`, decision: 'deferred', origin: 'research-run', evidence: { found: 0, rising: rising.length, openGaps: gaps.length, seasonality: seasonal.known ? seasonal : seasonal.reason, note: 'No candidate topic in the real data; nothing was proposed (no quota is filled).' }, enforced: mode === 'on' }, { dedupeToday: true, now, timezone: tz }).catch(() => null);
      return { ...out, skipped: 'no-candidates' };
    }

    // 2. the same gate the shipping loop uses
    const { entries } = await d.getIndex(site.id);
    const reused = await d.recentRelevance(site.id, candidates.map((c) => c.topicKey)).catch(() => new Map());
    const toJudge = candidates.filter((c) => !reused.has(c.topicKey)).map((c) => c.topic);
    const judged = toJudge.length ? await d.judge(site.id, toJudge) : new Map();
    const evaluated = [];
    for (const c of candidates) {
      const relevance = reused.get(c.topicKey) || judged.get(c.topic) || { verdict: 'unknown', reasons: ['relevance could not be judged'] };
      const index = d.checkIndex({ topic: c.topic, entries });
      const ev = await d.gather(site.id, { params: {}, detecting_agents: c.signals.detectors }, c.topic).catch((err) => ({ gsc: { unavailable: String(err.message).slice(0, 100), relatedQueries: [], rankingPages: [] }, demand: null, coverage: null, signals: {} }));
      // A rising query's own weekly impressions are real search evidence even if the related-query lookup finds nothing else.
      const gsc = c.recentImpressions ? { ...ev.gsc, relatedQueries: [{ query: c.topic, impressions: c.recentImpressions, clicks: 0, position: null }, ...(ev.gsc.relatedQueries || [])] } : ev.gsc;
      const result = evaluateTopic({
        topic: c.topic, relevance, index, coverage: ev.coverage, gsc, demand: c.demand?.searchVolume != null ? c.demand : ev.demand,
        signals: { competitor: c.signals.competitor || ev.signals.competitor, trend: c.signals.trend || ev.signals.trend, detectors: [...new Set([...(c.signals.detectors || []), ...(ev.signals.detectors || [])])] },
      });
      evaluated.push({ c, result });
    }
    const ranked = evaluated.filter((e) => e.result.decision === 'accepted')
      .sort((a, b) => (b.result.priority + Math.min(10, Math.log10(1 + (b.c.projection?.projected || 0)) * 3)) - (a.result.priority + Math.min(10, Math.log10(1 + (a.c.projection?.projected || 0)) * 3)) || a.c.topic.localeCompare(b.c.topic));
    const alreadyThisCycle = await d.recentProposals(site.id).catch(() => 0);
    const room = Math.max(0, Math.min(out.need, cap - alreadyThisCycle));
    const chosen = ranked.slice(0, room);
    const turnedAway = evaluated.filter((e) => e.result.decision !== 'accepted');
    const alternatives = turnedAway.slice(0, 8).map((e) => ({ topic: e.c.topic, decision: e.result.decision, why: e.result.reasons[0] || null }));
    out.accepted = ranked.length; out.rejected = turnedAway.filter((e) => e.result.decision === 'rejected').length; out.deferred = turnedAway.filter((e) => e.result.decision === 'deferred').length;

    // 3. decide, log every candidate, propose only the chosen ones, and only when switched on
    for (const e of evaluated) {
      const isChosen = chosen.includes(e);
      const decisionId = await d.record(site.id, {
        topic: e.c.topic, decision: e.result.decision, origin: 'research', gates: e.result.gates,
        evidence: { items: e.result.evidence, origins: e.c.origins, notes: e.c.notes, projection: e.c.projection || null, rank: ranked.indexOf(e) >= 0 ? ranked.indexOf(e) + 1 : null, chosen: isChosen, poolBefore: out.pool, target, proposalCap: cap, proposalsThisCycle: alreadyThisCycle },
        relevance: e.result.relevance, priority: e.result.priority, alternatives: e.result.decision === 'accepted' ? alternatives : [], enforced: mode === 'on' && isChosen,
      }, { dedupeToday: true, now, timezone: tz }).catch(() => null);
      if (isChosen && mode === 'on') {
        const p = await d.createProposal(site.id, e.c, { reason: `Chosen by topic research. ${e.c.notes.join(' ')}`.trim() }).catch((err) => ({ eligible: false, reason: err.message }));
        if (p?.recommendationId) { out.proposed++; if (decisionId) await d.setDecisionRec(site.id, decisionId, p.recommendationId).catch(() => {}); }
        else log(`[topic-research] site ${site.id}: "${e.c.topic}" accepted but not proposed (${p?.reason || 'not eligible'})`);
      }
    }
    log(`[topic-research] site ${site.id} (${mode}): pool ${out.pool}/${target}, ${candidates.length} candidate(s), ${ranked.length} accepted, ${chosen.length} chosen${mode === 'on' ? `, ${out.proposed} proposed` : ' (log only: nothing created)'}, ${out.rejected} rejected, ${out.deferred} held.`);
    return out;
  } catch (err) {
    log(`[topic-research] site ${site.id}: ${err.message}`);
    return { ...out, error: err.message };
  }
}

/** Every project, independently: one failing never stops the others. */
export async function runTopicResearchForAllSites({ sites = null, mode = topicResearchMode(), deps = null, now = new Date(), log = console.log } = {}) {
  let list = sites;
  if (!list) {
    const [{ listSites }, { isShippable }] = await Promise.all([import('../../store/read.js'), import('../ship-window.js')]);
    list = (await listSites()).filter(isShippable);
  }
  const results = [];
  for (const site of list) results.push(await runTopicResearchForSite(site, { mode, deps, now, log }));
  return results;
}

