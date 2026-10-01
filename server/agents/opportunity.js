import { getSearchPerformanceRange, getTopPagePerQuery } from '../store/read.js';
import { analyzePageUrl, recommendationsFor, TAG_TO_GENERATOR, inferSchemaType } from './lib/page-content.js';
import { priorityByRank, impactFromValue, effortFromDifficulty, makeFinding } from './lib/findings.js';
import { callLLM } from '../llm.js';
import { clipWindowToLag, GSC_LAG_DAYS } from './lib/window-coverage.js';
import {
  ctrAtPosition, TARGET_POSITION, TRAFFIC_GAIN_NOTE, TRAFFIC_GAIN_BASIS, DIFFICULTY_NOTE,
  opportunityScore as scoreOpportunity, estimatedTrafficGain as scoreTrafficGain, estimatedDifficulty as scoreDifficulty,
} from './lib/opportunity-scoring.js';

export const meta = {
  id: 'opportunity',
  name: 'Opportunity Agent',
  description: 'Finds striking-distance queries and pages worth optimizing.',
  category: 'seo',
  version: 3,
  requiresCapabilities: ['gsc'],
};

// "Striking distance" = ranking just off page 1, close enough that a push
// could move the needle.
const STRIKING_MIN_POSITION = 5;
const STRIKING_MAX_POSITION = 15;
// Raised from 10: a query with a dozen impressions is position noise (one
// impression at #3 moves a 12-impression average by a full place).
export const MIN_IMPRESSIONS = 30;
const MAX_OPPORTUNITIES = 20;
// The whole range must carry at least this much search exposure before any
// opportunity ranking means anything — site 8864 had zero rows and the
// narrative still said "page looks solid, stable performance".
export const MIN_TOTAL_IMPRESSIONS = 100;

// Windows end at 'today' but GSC's last ~3 days are not final; striking-
// distance averages are read over the final days only.
export function opportunityWindow(start, end, today) {
  return clipWindowToLag({ start, end }, GSC_LAG_DAYS, today) || { start, end };
}

export async function run({ siteId, start: rawStart, end: rawEnd, pageCache }) {
  const { start, end } = opportunityWindow(rawStart, rawEnd);
  // Falls back to a direct (uncached) fetch when run standalone, outside an
  // orchestrated run — keeps this agent independently runnable/testable
  // with identical output either way (see lib/fetch-cache.js).
  const fetchPage = pageCache || analyzePageUrl;
  const [perf, pages] = await Promise.all([
    getSearchPerformanceRange(siteId, start, end, 'query', 100),
    getTopPagePerQuery(siteId, start, end),
  ]);
  const pageByQuery = new Map(pages.map((p) => [p.query, p.page]));

  // No usable search data in range is NOT "the pages are fine" — abstain
  // before scoring or calling the LLM, which would otherwise be handed an
  // empty list and invent a reassuring narrative.
  const totalImpressions = perf.reduce((s, q) => s + Number(q.impressions || 0), 0);
  if (perf.length === 0 || totalImpressions < MIN_TOTAL_IMPRESSIONS) {
    return {
      meta, status: 'insufficient-data',
      facts: { rangeStart: start, rangeEnd: end, opportunities: [], count: 0, findings: [], totalImpressions },
      narrative: null,
      message: `Only ${totalImpressions} search impressions between ${start} and ${end} (need at least ${MIN_TOTAL_IMPRESSIONS}) — not enough Search Console data to rank opportunities.`,
      generatedAt: new Date().toISOString(),
    };
  }

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

  const scored = candidates.map((c) => ({
    ...c,
    opportunityScore: scoreOpportunity(c.impressions, c.avgPosition, STRIKING_MIN_POSITION, STRIKING_MAX_POSITION),
    estimatedTrafficGain: scoreTrafficGain(c.impressions, c.ctr, targetCtr),
    // From a fixed generic CTR-by-position curve, not measured for this site —
    // carried on the row so no consumer can show the number as a fact.
    estimatedTrafficGainBasis: TRAFFIC_GAIN_BASIS,
    estimatedDifficulty: scoreDifficulty(c.avgPosition, c.impressions, maxImpressions, STRIKING_MIN_POSITION, STRIKING_MAX_POSITION),
  }));

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
      basis: TRAFFIC_GAIN_BASIS, // estimatedTrafficGain is a labeled projection, not a measured value
      value: o.estimatedTrafficGain,
    };
    const effort = effortFromDifficulty(o.estimatedDifficulty);
    // inferSchemaType abstains rather than defaulting to 'Article' on a path
    // it cannot recognise, so a schema-generator action may now have no type
    // to offer. generators/schema.js throws a 400 on a missing schemaType, so
    // emitting one anyway would queue work that can only ever fail — drop the
    // action instead and leave the finding itself, which is still true.
    const schemaType = inferSchemaType(o.page, o.schemaTypes);
    return o.recommendations.map((tag) => makeFinding({
      id: `opportunity:${o.page}:${o.query}:${tag}`,
      evidence: { query: o.query, page: o.page, avgPosition: o.avgPosition, impressions: o.impressions, clicks: o.clicks, opportunityScore: o.opportunityScore },
      whyItMatters: `"${o.query}" ranks #${o.avgPosition.toFixed(1)}, ${o.impressions} impressions — estimated (generic CTR curve, not measured for this site) +${o.estimatedTrafficGain} clicks if it reached position ${TARGET_POSITION}.`,
      priority,
      recommendedAction: TAG_TO_GENERATOR[tag] === 'schema' && !schemaType
        ? null
        : { label: tag, generatorId: TAG_TO_GENERATOR[tag] ?? null, params: { page: o.page, query: o.query, schemaType }, effort },
      expectedImpact,
    }));
  });

  // Candidates exist in the data but none sit in striking distance: report
    // that plainly instead of asking the LLM to narrate an empty list.
  if (opportunities.length === 0) {
    return {
      meta, status: 'insufficient-data',
      facts: { rangeStart: start, rangeEnd: end, opportunities: [], count: 0, findings: [], totalImpressions },
      narrative: null,
      message: `No query with at least ${MIN_IMPRESSIONS} impressions ranks between positions ${STRIKING_MIN_POSITION} and ${STRIKING_MAX_POSITION} in this range.`,
      generatedAt: new Date().toISOString(),
    };
  }

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    opportunities,
    count: opportunities.length,
    findings,
    assumptions: {
      targetPosition: TARGET_POSITION,
      trafficGainNote: TRAFFIC_GAIN_NOTE,
      trafficGainBasis: TRAFFIC_GAIN_BASIS,
      difficultyNote: DIFFICULTY_NOTE,
    },
  };

  const system = 'You are an SEO strategist writing for a non-technical site owner. Given striking-distance ' +
    'opportunities (real position/impressions/clicks/CTR, an opportunity score, an estimated traffic gain, a ' +
    '1-5 difficulty proxy, and page-derived recommendations), write 2-3 sentences naming the top 2-3 opportunities ' +
    'by score and their recommended actions. recommendations is an empty array [] when the page was fetched ' +
    'successfully and already covers everything checked — that is GOOD news, say that page\'s checked items look ' +
    'covered (say nothing broader about the page\'s performance), do not ' +
    'call it a failure or missing data. recommendations is null ONLY when recommendationsNote explains a real ' +
    'fetch failure — only then say recommendations were unavailable, and never invent one. Use ONLY the numbers ' +
    'given — traffic gain and difficulty are estimates, say so if you cite them. A lower average position is ' +
    'BETTER. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 300 })
    .catch((err) => { console.warn('[agents] opportunity narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
