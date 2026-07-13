import { getCompetitorRankingDates, getCompetitorRankingsOn, getSearchPerformanceRange } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'competitor-intelligence',
  name: 'Competitor Intelligence Agent',
  description: 'Finds which real competitors outrank this site on its own tracked search queries.',
  category: 'seo',
  version: 1,
  dataSources: [
    { id: 'competitor-analysis', status: 'connected', description: 'Real Google organic SERP results via DataForSEO, checked weekly for this site\'s own top tracked queries.' },
  ],
};

const MIN_IMPRESSIONS = 5;

// Rankings are checked weekly (see ingest/competitors.js), not daily like
// every other agent's GSC/GA4-backed data — so "recent vs prior" here means
// the last two dates a check actually ran, not a fixed day offset.
export async function run({ siteId, start, end }) {
  const dates = await getCompetitorRankingDates(siteId, 2);
  if (!dates.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'No competitor ranking checks have run yet — the first weekly check will populate this.',
      generatedAt: new Date().toISOString(),
    };
  }

  const [latestDate, priorDate] = dates;
  const [latestRows, priorRows, perf] = await Promise.all([
    getCompetitorRankingsOn(siteId, latestDate),
    priorDate ? getCompetitorRankingsOn(siteId, priorDate) : Promise.resolve([]),
    getSearchPerformanceRange(siteId, start, end, 'query', 200),
  ]);
  const impressionsByQuery = new Map(perf.map((p) => [p.dim_value, Number(p.impressions)]));

  const byQuery = new Map();
  for (const r of latestRows) {
    if (!byQuery.has(r.query)) byQuery.set(r.query, []);
    byQuery.get(r.query).push(r);
  }
  const priorByQueryDomain = new Map(priorRows.map((r) => [`${r.query}::${r.domain}`, r.position]));

  const candidates = [];
  for (const [query, rows] of byQuery) {
    const ownRow = rows.find((r) => r.is_own_domain);
    const competitors = rows.filter((r) => !r.is_own_domain).sort((a, b) => a.position - b.position);
    const topCompetitor = competitors[0];
    if (!topCompetitor) continue; // no real competitor found for this query — nothing to report

    const ownPosition = ownRow?.position ?? null;
    // Beaten = a real competitor ranks above us, or we don't appear in the
    // tracked top 20 at all while a competitor does.
    const beaten = ownPosition == null || topCompetitor.position < ownPosition;
    if (!beaten) continue;

    const impressions = impressionsByQuery.get(query) ?? 0;
    if (impressions < MIN_IMPRESSIONS) continue; // only queries with real search demand

    const priorPosition = priorByQueryDomain.get(`${query}::${topCompetitor.domain}`) ?? null;
    candidates.push({ query, ownPosition, topCompetitor, impressions, priorPosition });
  }

  // Ranked by real search demand — the same "impressions decide what matters
  // most" signal every other agent in this family already uses.
  candidates.sort((a, b) => b.impressions - a.impressions);
  const priorities = priorityByRank(candidates);

  const findings = candidates.map((c, i) => {
    const priority = priorities[i];
    const trend = c.priorPosition != null ? c.priorPosition - c.topCompetitor.position : null; // positive = competitor climbing
    return makeFinding({
      id: `competitor-intelligence:${c.query}:${c.topCompetitor.domain}`,
      evidence: {
        query: c.query, competitorDomain: c.topCompetitor.domain, competitorPosition: c.topCompetitor.position,
        ownPosition: c.ownPosition, impressions: c.impressions, trend,
      },
      whyItMatters: c.ownPosition == null
        ? `"${c.topCompetitor.domain}" ranks #${c.topCompetitor.position} for "${c.query}" (${c.impressions} impressions) — you don't appear in the top 20.`
        : `"${c.topCompetitor.domain}" ranks #${c.topCompetitor.position} for "${c.query}" vs your #${c.ownPosition} (${c.impressions} impressions).`,
      priority,
      // No generator fits "outrank a specific named competitor" — a real,
      // worthwhile finding with no forced draftable action, same honest
      // pattern as device-intelligence/query-intelligence.
      recommendedAction: null,
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: c.impressions },
    });
  });

  const facts = {
    rangeStart: start, rangeEnd: end, latestCheckDate: latestDate, priorCheckDate: priorDate || null,
    queriesChecked: byQuery.size, findings,
  };

  const system = 'You are an SEO strategist writing for a non-technical site owner. Given real competitor SERP ' +
    'rankings (which named competitor domain outranks this site, on which of the site\'s own real search queries, ' +
    'with real impressions and, when available, whether that competitor is climbing or falling since the last ' +
    'weekly check), write 2-3 sentences naming the most damaging real competitive loss by search demand. Use ONLY ' +
    'the data given, never invent a competitor name or number not present in the facts. A lower position is ' +
    'BETTER. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = findings.length
    ? await callLLM(system, user, { maxTokens: 300 }).catch((err) => { console.warn('[agents] competitor-intelligence narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
