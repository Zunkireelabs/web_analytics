import { getSearchPerformanceRange, getTopPagePerQuery } from '../store/read.js';
import { analyzePageUrl, recommendationsFor, TAG_TO_GENERATOR, inferSchemaType } from './lib/page-content.js';
import { priorityByRank, impactFromValue, effortFromDifficulty, makeFinding } from './lib/findings.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'opportunity',
  name: 'Opportunity Agent',
  description: 'Finds striking-distance queries and pages worth optimizing.',
  category: 'seo',
  version: 3,
};

// "Striking distance" = ranking just off page 1, close enough that a push
// could move the needle.
const STRIKING_MIN_POSITION = 5;
const STRIKING_MAX_POSITION = 15;
const MIN_IMPRESSIONS = 10;
const MAX_OPPORTUNITIES = 20;

// Realistic improvement target used to project traffic gain (page-1-top,
// not an unrealistic #1).
const TARGET_POSITION = 3;

// Approximate industry-aggregate organic CTR by position (blended desktop/
// mobile, order-of-magnitude only). This is NOT measured for this site and
// is never presented as one — it's solely the baseline used to project
// estimatedTrafficGain, and is always accompanied by `assumptions` in the
// output so it can't be mistaken for an observed fact.
const CTR_BY_POSITION = { 1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.07, 6: 0.05, 7: 0.04, 8: 0.03, 9: 0.025, 10: 0.02 };
const CTR_TAIL = 0.015; // positions 11+
const ctrAtPosition = (p) => CTR_BY_POSITION[Math.round(p)] ?? CTR_TAIL;

export async function run({ siteId, start, end, pageCache }) {
  // Falls back to a direct (uncached) fetch when run standalone, outside an
  // orchestrated run — keeps this agent independently runnable/testable
  // with identical output either way (see lib/fetch-cache.js).
  const fetchPage = pageCache || analyzePageUrl;
  const [perf, pages] = await Promise.all([
    getSearchPerformanceRange(siteId, start, end, 'query', 100),
    getTopPagePerQuery(siteId, start, end),
  ]);
  const pageByQuery = new Map(pages.map((p) => [p.query, p.page]));

  const candidates = perf
    .filter((q) => q.avg_position != null
      && q.avg_position >= STRIKING_MIN_POSITION && q.avg_position <= STRIKING_MAX_POSITION
      && Number(q.impressions) >= MIN_IMPRESSIONS)
    .map((q) => ({
      query: q.dim_value,
      page: pageByQuery.get(q.dim_value) || null,
      avgPosition: Number(q.avg_position),
      impressions: Number(q.impressions),
      clicks: Number(q.clicks),
      ctr: Number(q.ctr),
    }));

  const maxImpressions = candidates.reduce((m, c) => Math.max(m, c.impressions), 1);
  const targetCtr = ctrAtPosition(TARGET_POSITION);

  const scored = candidates.map((c) => {
    const positionFactor = Math.min(1, Math.max(0,
      (STRIKING_MAX_POSITION - c.avgPosition) / (STRIKING_MAX_POSITION - STRIKING_MIN_POSITION)));
    const opportunityScore = Math.round(c.impressions * positionFactor);
    const estimatedTrafficGain = Math.max(0, Math.round(c.impressions * (targetCtr - c.ctr)));

    // Difficulty proxy: harder = further from page 1 + more impression volume
    // relative to this batch. Internal signals only — no backlink/competitor
    // data exists, so this is explicitly a proxy, not true keyword difficulty.
    const positionComponent = (c.avgPosition - STRIKING_MIN_POSITION) / (STRIKING_MAX_POSITION - STRIKING_MIN_POSITION);
    const volumeComponent = c.impressions / maxImpressions;
    const estimatedDifficulty = Math.min(5, Math.max(1, Math.round((0.5 * positionComponent + 0.5 * volumeComponent) * 4) + 1));

    return { ...c, opportunityScore, estimatedTrafficGain, estimatedDifficulty };
  });

  const top = scored.sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, MAX_OPPORTUNITIES);

  // Live-fetch each unique landing page once, shared across queries that
  // land on the same page — and, when run inside an orchestration cycle,
  // shared across OTHER agents too via pageCache (see lib/fetch-cache.js),
  // not just within this one agent's own batch.
  const pageAnalysisCache = new Map(
    await Promise.all([...new Set(top.map((o) => o.page).filter(Boolean))].map(async (url) => [url, await fetchPage(url)]))
  );

  const opportunities = top.map((o) => {
    if (!o.page) return { ...o, recommendations: null, recommendationsNote: 'No landing page recorded for this query.' };
    const fetched = pageAnalysisCache.get(o.page);
    if (!fetched.ok) return { ...o, recommendations: null, recommendationsNote: `Page fetch failed (${fetched.error}) — recommendations unavailable.` };
    return { ...o, recommendations: recommendationsFor(fetched.analysis, o.query), recommendationsNote: null, schemaTypes: fetched.analysis.schemaTypes };
  });

  // `opportunities` is already sorted best-first by opportunityScore (see
  // `top` above) — priorityByRank reuses that real ranking directly, one
  // finding per recommended tag on each opportunity.
  const priorities = priorityByRank(opportunities);
  const findings = opportunities.flatMap((o, i) => {
    if (!o.recommendations?.length) return [];
    const priority = priorities[i];
    const expectedImpact = {
      label: impactFromValue(o.estimatedTrafficGain, { high: 20, medium: 5 }) || 'Low',
      basis: 'estimate', // estimatedTrafficGain is a labeled projection, not a measured value
      value: o.estimatedTrafficGain,
    };
    const effort = effortFromDifficulty(o.estimatedDifficulty);
    return o.recommendations.map((tag) => makeFinding({
      id: `opportunity:${o.page}:${o.query}:${tag}`,
      evidence: { query: o.query, page: o.page, avgPosition: o.avgPosition, impressions: o.impressions, clicks: o.clicks, opportunityScore: o.opportunityScore },
      whyItMatters: `"${o.query}" ranks #${o.avgPosition.toFixed(1)}, ${o.impressions} impressions — est. +${o.estimatedTrafficGain} clicks if improved.`,
      priority,
      recommendedAction: { label: tag, generatorId: TAG_TO_GENERATOR[tag] ?? null, params: { page: o.page, query: o.query, schemaType: inferSchemaType(o.page, o.schemaTypes) }, effort },
      expectedImpact,
    }));
  });

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    opportunities,
    count: opportunities.length,
    findings,
    assumptions: {
      targetPosition: TARGET_POSITION,
      trafficGainNote: `estimatedTrafficGain assumes the query reaches position ${TARGET_POSITION} and applies an ` +
        'approximate industry-average CTR-by-position curve — an estimate, not a guarantee, not measured for this site.',
      difficultyNote: 'estimatedDifficulty (1-5) is an internal proxy from current position + relative impression ' +
        'volume only — not true keyword difficulty, since no backlink/competitor data source exists.',
    },
  };

  const system = 'You are an SEO strategist writing for a non-technical site owner. Given striking-distance ' +
    'opportunities (real position/impressions/clicks/CTR, an opportunity score, an estimated traffic gain, a ' +
    '1-5 difficulty proxy, and page-derived recommendations), write 2-3 sentences naming the top 2-3 opportunities ' +
    'by score and their recommended actions. recommendations is an empty array [] when the page was fetched ' +
    'successfully and already covers everything checked — that is GOOD news, say the page looks solid, do not ' +
    'call it a failure or missing data. recommendations is null ONLY when recommendationsNote explains a real ' +
    'fetch failure — only then say recommendations were unavailable, and never invent one. Use ONLY the numbers ' +
    'given — traffic gain and difficulty are estimates, say so if you cite them. A lower average position is ' +
    'BETTER. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 300 })
    .catch((err) => { console.warn('[agents] opportunity narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
