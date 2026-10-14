import { rankTopicCandidates, topicKeyFor, DEFAULT_QUEUE_LIMIT, isTopicScorerEnabled } from './topic-scorer.js';
import { pickBestGoalAlignment } from './goal-alignment.js';

// The impure half of the topic scorer: gather the evidence, hand it to the
// pure ranker, persist the result.
//
// Split from topic-scorer.js deliberately — the scoring policy is the part
// that will be argued about and retuned, and it must stay testable without a
// database, a provider or an LLM.
//
// EVERY HEAVY DEPENDENCY IS IMPORTED LAZILY, for the same reason
// lib/tenant-context.js does it: this module is imported by agents whose
// tests mock store/read.js and friends with a PARTIAL set of named exports,
// and an eager chain through keyword-coverage-service.js turns a missing
// export into a SyntaxError at instantiate time in a test that never asked
// for a topic queue (confirmed: trend-radar.test.js). It also means that
// with TOPIC_SCORER_ENABLED off, none of this is ever loaded.

// Merge the same topic proposed by several pipelines into ONE candidate
// carrying both sources. This is the step that makes "both trending and
// searched" visible at all; without it the two arrive as two rows and the
// corroboration is lost.
export function mergeCandidates(candidates = []) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = topicKeyFor(c.topic);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...c, topicKey: key, sources: [...new Set([c.origin, ...(c.sources || [])].filter(Boolean))] });
      continue;
    }
    byKey.set(key, {
      ...existing,
      // The better-evidenced fields win per field, not per candidate: a
      // trend-radar entry carries real headlines and a keyword-gap entry
      // carries real volume, and the merged topic deserves both.
      demand: existing.demand?.available ? existing.demand : (c.demand ?? existing.demand),
      trend: existing.trend ?? c.trend,
      llmEstimatedVolume: existing.llmEstimatedVolume ?? c.llmEstimatedVolume,
      coverageStatus: existing.coverageStatus ?? c.coverageStatus,
      relevance: existing.relevance ?? c.relevance,
      intent: existing.intent ?? c.intent,
      // Keep the longer display title: a trend headline-derived topic is
      // usually the more readable of the two.
      topic: (c.topic || '').length > (existing.topic || '').length ? c.topic : existing.topic,
      sources: [...new Set([...existing.sources, c.origin, ...(c.sources || [])].filter(Boolean))],
    });
  }
  return [...byKey.values()];
}

async function loadDefaultDeps() {
  const [registry, coverage, claims, suppressions, store, tenant, goals] = await Promise.all([
    import('../../providers/search-demand/registry.js'),
    import('./keyword-coverage-service.js'),
    import('./work-claims.js'),
    import('../../store/fix-suppressions.js'),
    import('../../store/topic-candidates.js'),
    import('../../lib/tenant-context.js'),
    import('../../store/site-goals.js'),
  ]);
  return {
    getProvider: registry.getSearchDemandProvider,
    classifyCoverage: coverage.classifyGapCoverage,
    activeClaim: claims.activeClaimFor,
    suppressionSet: suppressions.getSuppressionSet,
    suppressionEnforcing: suppressions.isSuppressionEnforcing,
    isSuppressed: suppressions.isSuppressed,
    persist: store.upsertTopicCandidates,
    existingByKeys: store.getTopicCandidatesByKeys,
    loadContext: tenant.loadTenantContext,
    activeGoals: goals.listActiveGoals,
  };
}

// The pure fallback, so a test that injects only some deps does not have to
// supply a suppression matcher it has no suppressions for.
const matchesSuppression = (d, set, args) => (d.isSuppressed ? d.isSuppressed(set, args) : false);

/**
 * Score and persist a batch of topic candidates for one site.
 *
 * `candidates` come from the producers: trend-radar's validated topics,
 * keyword gaps, analyst conclusions. Each needs only `{ topic, origin }`;
 * everything else is gathered here.
 *
 * Returns the ranked result, so a caller can use it directly without a
 * second read. Persisting is best effort — a queue that could not be written
 * must not stop the caller from acting on the ranking it already has.
 */
export async function buildTopicQueue(siteId, candidates = [], { limit = DEFAULT_QUEUE_LIMIT, deps = {} } = {}) {
  const merged = mergeCandidates(candidates);
  // Before anything is loaded: an empty batch must cost nothing at all.
  if (!merged.length) return { queued: [], overflow: [], dropped: [], persisted: 0 };
  const d = { ...(await loadDefaultDeps()), ...deps };

  // --- demand, in ONE provider call for the whole batch
  const provider = d.getProvider();
  const demandByTopic = await provider.fetchDemandBulk(merged.map((c) => c.topic))
    .catch((err) => {
      console.warn(`[topic-queue] demand lookup failed for site ${siteId}: ${err.message}`);
      return new Map();
    });

  // --- goals, product relevance, suppressions, and what a PREVIOUS cycle
  //     already recorded about these same topics. That last read is what
  //     lets corroboration cross a cron boundary: trend-radar and the
  //     keyword ship cycle run on different schedules and are never in
  //     memory together, so without it "both trending and searched" could
  //     only be noticed in the rare case both arrived in one batch.
  const [goals, ctx, suppressions, existing] = await Promise.all([
    d.activeGoals(siteId).catch(() => []),
    d.loadContext(siteId).catch(() => null),
    d.suppressionEnforcing() ? d.suppressionSet(siteId).catch(() => new Set()) : Promise.resolve(new Set()),
    d.existingByKeys
      ? d.existingByKeys(siteId, merged.map((c) => c.topicKey)).catch(() => new Map())
      : Promise.resolve(new Map()),
  ]);

  const enriched = await Promise.all(merged.map(async (c) => {
    const prior = existing.get(c.topicKey) || null;
    // A topic a previous cycle already SHIPPED is not a candidate. The page
    // exists; re-queueing it is the duplicate work this whole layer exists
    // to prevent, and the claims ledger cannot catch it once the claim has
    // been released.
    if (prior?.status === 'shipped') return { ...c, dropped: 'already-shipped' };

    // Coverage through the ONE authority (migration 179's verdicts), never
    // through trend-radar's slug matching — which cannot see a page covering
    // the topic in different words, nor tell "covered" from "covered, but
    // not in this language". persist:false because a topic candidate is not
    // a keyword_gaps row and has no id to write a verdict back to.
    const coverageStatus = c.coverageStatus ?? await d.classifyCoverage(siteId, { topic: c.topic }, { persist: false, allowLLM: false })
      .then((r) => r?.status ?? null)
      .catch(() => null);

    const claim = await d.activeClaim(siteId, 'topic', c.topic).catch(() => null);

    // Goal alignment reuses the existing evaluator rather than a second
    // notion of "does this serve a goal" — a topic is shaped into the
    // minimal finding it understands.
    const goalAlignment = goals.length
      ? pickBestGoalAlignment(goals, { title: c.topic, description: c.topic, recommendedAction: { generatorId: 'blog-outline' } })
      : null;

    return {
      ...c,
      // Union with whatever a previous cycle recorded, so a topic proposed
      // by the trend feed last week and by the keyword pipeline today is
      // credited with both.
      sources: [...new Set([...(c.sources || []), ...(prior?.sources || [])].filter(Boolean))],
      demand: c.demand?.available
        ? c.demand
        : (demandByTopic.get(c.topic) ?? (prior?.demand?.available ? prior.demand : null) ?? c.demand ?? null),
      coverageStatus,
      claimed: Boolean(claim),
      suppressed: matchesSuppression(d, suppressions, { scope: 'topic', scopeKey: c.topic, generatorId: 'blog-outline' }),
      goalAlignment,
      relevance: c.relevance ?? relevanceFromContext(ctx),
    };
  }));

  const ranked = rankTopicCandidates(enriched, { limit });

  // Everything scored is persisted, queued and dropped alike: the reason a
  // topic did NOT make the queue is the most useful thing to read later.
  const rows = [...ranked.queued, ...ranked.overflow, ...ranked.dropped].map((s) => ({
    topicKey: s.topicKey || topicKeyFor(s.topic),
    topic: s.topic,
    origin: s.candidate?.origin || 'manual',
    sources: s.candidate?.sources || [],
    intent: s.candidate?.intent || 'new-blog',
    score: s.score,
    components: s.components,
    demand: s.candidate?.demand || null,
    coverageStatus: s.candidate?.coverageStatus || null,
    dropped: s.dropped,
  })).filter((r) => r.topicKey);

  const persisted = await d.persist(siteId, rows).catch((err) => {
    console.warn(`[topic-queue] could not persist the queue for site ${siteId}: ${err.message}`);
    return 0;
  });

  return { ...ranked, persisted };
}

// The tenant-wide relevance fallback, used when a candidate carries no
// per-topic verdict of its own. Intentionally coarse: a site-level signal
// cannot say whether ONE topic is core, so it reports 'unknown' rather than
// claiming a level — which the scorer treats as neutral. The per-topic
// verdict, when a keyword gap has one, always wins over this.
function relevanceFromContext(ctx) {
  if (!ctx) return null;
  return { productRelevance: 'unknown', confidence: ctx.productKnowledge?.length ? 'medium' : 'low' };
}

// What the ship cycle calls instead of its own top-5-by-volume pool. Falls
// back to an empty list when the scorer is off, so the caller keeps its
// existing behaviour until the flag is flipped.
export async function nextTopicsToShip(siteId, { limit = 3 } = {}) {
  if (!isTopicScorerEnabled()) return [];
  const { listQueuedTopics } = await import('../../store/topic-candidates.js');
  return listQueuedTopics(siteId, { limit }).catch(() => []);
}
