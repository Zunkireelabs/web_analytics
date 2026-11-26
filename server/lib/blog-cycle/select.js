// THE BATCH GATE for the shipping loop. Called by agents/lib/auto-remediation.js on the eligible list BEFORE pacing, so the blog day's ceiling is
// filled from topics that already passed the evidence gate (a rejected topic never takes one of the five slots).
//
// Modes (BLOG_EVIDENCE_GATE): 'off' does nothing. 'log' (default) evaluates and RECORDS every decision but returns the list unchanged, so deploying
// this changes nothing by itself and the log shows what enforcing would do. 'enforce' removes rejected and deferred topics and orders the accepted ones
// by priority (relevance first, volume only as a tiebreak among relevant topics). In enforce mode an error holds the blogs (fail closed) and lets every
// other generator through; in log mode an error is swallowed (fail open), exactly like the other observability hooks.
import { evaluateTopic } from './evidence-gate.js';
import { blogCycleCeiling, blogGateMode } from './ceiling.js';
import { operatorDetail } from '../errors.js';

const BLOG = 'blog-outline';
const topicOf = (rec) => String(rec?.params?.topic || rec?.params?.keyword || rec?.issue || '').trim();

async function defaultDeps() {
  const [ci, rel, gather, log, ne] = await Promise.all([
    import('../content-index/store.js'), import('./relevance.js'), import('./gather.js'), import('../topic-research/decision-log.js'), import('../content-index/check.js'),
  ]);
  return {
    getIndex: (siteId) => ci.getFreshContentIndex(siteId),
    judge: (siteId, topics) => rel.judgeRelevance(siteId, topics),
    gather: (siteId, rec, topic) => gather.gatherTopicEvidence(siteId, rec, topic),
    checkIndex: ne.checkTopicAgainstIndex,
    record: (siteId, d, opts) => log.recordTopicDecision(siteId, d, opts),
    recentRelevance: (siteId, keys) => log.recentRelevanceVerdicts(siteId, keys),
  };
}

/**
 * @returns {Promise<{ kept: Array, decisions: Array, notes: string[] }>} `kept` is the list the caller should continue with.
 */
export async function applyBlogEvidenceGate(site, eligible, { mode = blogGateMode(), deps = null, now = new Date(), log = console.log } = {}) {
  const blogs = (eligible || []).filter((r) => r?.recommendation_type === BLOG);
  if (mode === 'off' || !blogs.length) return { kept: eligible, decisions: [], notes: [] };
  const notes = [];
  try {
    const d = { ...(await defaultDeps()), ...(deps || {}) };
    const { entries } = await d.getIndex(site.id);
    const topicKeyOf = (await import('../content-index/normalize.js')).topicKey;

    // Verdicts judged recently are reused (a relevance verdict about a topic does not change from one 20-minute pass to the next).
    const topics = blogs.map(topicOf).filter(Boolean);
    const reused = await d.recentRelevance(site.id, topics.map(topicKeyOf)).catch(() => new Map());
    const needJudging = topics.filter((t) => !reused.has(topicKeyOf(t)));
    const judged = needJudging.length ? await d.judge(site.id, needJudging) : new Map();

    const evaluated = [];
    for (const rec of blogs) {
      const topic = topicOf(rec);
      if (!topic) { evaluated.push({ rec, topic: '', result: { decision: 'rejected', gates: [{ gate: 'has-topic', ok: false, detail: 'the recommendation names no topic' }], evidence: [], priority: null, relevance: null, reasons: ['no topic'] } }); continue; }
      const relevance = reused.get(topicKeyOf(topic)) || judged.get(topic) || { verdict: 'unknown', reasons: ['relevance could not be judged'] };
      const index = d.checkIndex({ topic, entries, ignoreDraftIds: [], blogsOnly: true });
      const { gsc, demand, coverage, signals } = await d.gather(site.id, rec, topic).catch((err) => ({ gsc: { unavailable: String(err.message).slice(0, 100), relatedQueries: [], rankingPages: [] }, demand: null, coverage: null, signals: { detectors: rec.detecting_agents || [] } }));
      const result = evaluateTopic({ topic, clientRequested: rec.params?.clientRequested === true, relevance, index, coverage, gsc, demand, signals });
      evaluated.push({ rec, topic, result });
    }

    const accepted = evaluated.filter((e) => e.result.decision === 'accepted').sort((a, b) => b.result.priority - a.result.priority || a.rec.id - b.rec.id);
    const turnedAway = evaluated.filter((e) => e.result.decision !== 'accepted');
    const alternatives = turnedAway.slice(0, 8).map((e) => ({ topic: e.topic, decision: e.result.decision, why: e.result.reasons[0] || null }));
    const ceiling = blogCycleCeiling();
    const decisions = [];
    for (const e of evaluated) {
      const rank = accepted.indexOf(e);
      decisions.push({
        topic: e.topic, decision: e.result.decision, origin: 'gate', gates: e.result.gates, evidence: { items: e.result.evidence, rank: rank >= 0 ? rank + 1 : null, ceiling, withinCeiling: rank >= 0 ? rank < ceiling : null },
        relevance: e.result.relevance, priority: e.result.priority, alternatives: e.result.decision === 'accepted' ? alternatives : [], enforced: mode === 'enforce', recommendationId: e.rec.id,
      });
    }
    for (const dec of decisions) await d.record(site.id, dec, { dedupeToday: true, now, timezone: site.timezone || undefined }).catch(() => null);

    notes.push(`blog evidence gate (${mode}): ${accepted.length} of ${blogs.length} topic(s) accepted${turnedAway.length ? `, ${turnedAway.length} turned away (${[...new Set(turnedAway.map((e) => e.result.reasons[0]?.split(':')[0]))].filter(Boolean).join(', ')})` : ''}; ceiling ${ceiling}.`);
    for (const e of turnedAway.slice(0, 5)) notes.push(`  - "${e.topic}": ${e.result.decision} — ${e.result.reasons[0]}`);

    if (mode !== 'enforce') return { kept: eligible, decisions, notes };
    // Every non-blog keeps its place; the blog slots are refilled, in order, by the accepted topics best first, so the other generators' priority
    // order is untouched and the blog lane sees its candidates in evidence order.
    const queue = accepted.map((e) => e.rec);
    const kept = [];
    for (const r of eligible) {
      if (r?.recommendation_type !== BLOG) { kept.push(r); continue; }
      if (queue.length) kept.push(queue.shift());
    }
    return { kept, decisions, notes };
  } catch (err) {
    notes.push(`blog evidence gate (${mode}) error: ${operatorDetail(err)}${mode === 'enforce' ? ' — blogs held this pass, other fixes continue' : ' — ignored (log mode)'}`);
    log(`[blog-cycle] site ${site.id}: ${notes.at(-1)}`);
    if (mode === 'enforce') return { kept: eligible.filter((r) => r?.recommendation_type !== BLOG), decisions: [], notes };
    return { kept: eligible, decisions: [], notes };
  }
}
