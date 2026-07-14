import { getCompetitorRankingDates, getCompetitorRankingsOn, getSearchPerformanceRange } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { runCompetitorDiscovery } from './lib/competitor-analysis.js';
import { upsertCompetitorProfile, insertCompetitorStructuralSnapshot } from '../store/competitor-profiles.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'competitor-intelligence',
  name: 'Competitor Intelligence Agent',
  description: 'Identifies real competitors by combining two lenses — real Google rankings when a SERP provider is configured, and AI market-research reasoning grounded in the site\'s own business content — compares content/SEO/AEO positioning against them, and enriches with live keyword rankings.',
  category: 'seo',
  version: 4,
  dataSources: [
    {
      id: 'serp-competitor-discovery', status: (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD) ? 'connected' : 'not-connected',
      description: 'Real Google organic SERP rankings via DataForSEO — who actually ranks for this site\'s own top queries, tallied across queries. A keyword-overlap signal; a true market competitor may not appear here at all.',
    },
    { id: 'llm-competitor-discovery', status: 'connected', description: 'AI market-research reasoning grounded in this site\'s own homepage content (industry, services, geography) — identifies real business/marketplace competitors, not just keyword overlap. Always runs alongside SERP discovery when available; a domain both agree on is the highest-confidence result.' },
  ],
};

const MIN_IMPRESSIONS = 5;

export async function run({ siteId, start, end }) {
  // Always-available path: LLM discovers real competitors, crawls them,
  // compares structural signals — never blocked on external SEO API
  // credentials existing. See lib/competitor-analysis.js.
  const discovery = await runCompetitorDiscovery(siteId, start, end);
  const reached = discovery.competitors.filter((c) => c.ok);
  const unreachable = discovery.competitors.filter((c) => !c.ok);

  // One timestamp shared by every domain this run identifies — lets
  // store/competitor-profiles.js select "this run's" competitors by exact
  // equality instead of a time-window heuristic (see its comment).
  const runAt = new Date();
  await Promise.all(reached.map((c) =>
    upsertCompetitorProfile(siteId, c.domain, { ...c.comparison, ownScore: c.ownScore, competitorScore: c.competitorScore, discoverySource: c.discoverySource }, runAt)
      .catch((err) => console.error(`[agents] competitor-intelligence: failed to save profile for ${c.domain}:`, err.message))
  ));
  // Real, insert-only history alongside the overwrite-per-domain profile
  // above — same run, same scores, just appended instead of overwritten
  // (see migration 034 / store/competitor-profiles.js).
  await Promise.all(reached.map((c) =>
    insertCompetitorStructuralSnapshot(siteId, c.domain, c.competitorScore, c.ownScore, runAt)
      .catch((err) => console.error(`[agents] competitor-intelligence: failed to save structural snapshot for ${c.domain}:`, err.message))
  ));

  const discoveryFindings = reached.map((c) => makeFinding({
    id: `competitor-intelligence:discovery:${c.domain}`,
    evidence: { domain: c.domain, ownScore: c.ownScore, competitorScore: c.competitorScore, discoverySource: c.discoverySource, ...c.comparison },
    whyItMatters: c.comparison.verdict || `${c.domain} was identified as a real competitor for this site's audience.`,
    // These are comparative/informational findings, not ranked by a single
    // real number the way ranking-based findings below are — 'medium' is an
    // honest flat default here (see expectedImpact.basis: 'estimate'),
    // never dressed up as a computed rank.
    priority: 'medium',
    recommendedAction: null,
    expectedImpact: { label: 'Medium', basis: 'estimate', value: null },
  }));

  // Enrichment path: real keyword-level "who outranks us" findings, only
  // produced when a SERP provider is actually configured and has real
  // ranking data (see ingest/competitors.js's weekly check) — additive on
  // top of the always-available discovery findings above, never blocking.
  const rankingFindings = await buildRankingFindings(siteId, start, end);

  const findings = [...discoveryFindings, ...rankingFindings];
  const facts = {
    rangeStart: start, rangeEnd: end,
    ownDomain: discovery.ownDomain,
    // Per-competitor, not a single run-wide value — 'both' (real Google
    // rankings agree with AI market-research reasoning) is the strongest
    // signal, 'serp' is keyword-verified only, 'llm' is market-knowledge
    // only. Surfaced to the UI so a reader always knows how each
    // competitor on the list was actually identified.
    discoverySource: reached.map((c) => ({ domain: c.domain, source: c.discoverySource })),
    competitorsIdentified: reached.map((c) => c.domain),
    competitorsUnreachable: unreachable.map((c) => ({ domain: c.domain, error: c.error })),
    comparisons: reached.map((c) => ({ domain: c.domain, ownScore: c.ownScore, competitorScore: c.competitorScore, ...c.comparison })),
    rankingDataAvailable: rankingFindings.length > 0,
    findings,
  };

  if (!findings.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: discovery.ownDomain
        ? 'Could not identify or reach any real competitor sites this run — try again once more page data has been ingested.'
        : 'No page data yet to identify competitors from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const system = 'You are an SEO strategist writing for a non-technical site owner. Given real, AI-identified ' +
    'competitors (with a structural comparison of content/SEO/AI-visibility signals) and, when available, real ' +
    'competitor SERP rankings on this site\'s own search queries, write 2-4 sentences: name the most notable real ' +
    'competitor and the single most actionable gap versus them, and if ranking data is present, name the most ' +
    'damaging real competitive loss by search demand. Use ONLY the data given, never invent a competitor name or ' +
    'number not present in the facts. A lower search position is BETTER. Plain text, no markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 350 })
    .catch((err) => { console.warn('[agents] competitor-intelligence narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}

// Preserves the original ranking-based logic exactly (same relative-demand
// prioritization, same finding shape) as an optional enrichment layer on
// top of the always-available discovery findings above — real keyword-level
// "who outranks us" data whenever a SERP provider is configured and has
// checked this week (see ingest/competitors.js). Returns [] with zero cost
// when no ranking data exists yet, rather than blocking the agent.
async function buildRankingFindings(siteId, start, end) {
  const dates = await getCompetitorRankingDates(siteId, 2);
  if (!dates.length) return [];

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
    const beaten = ownPosition == null || topCompetitor.position < ownPosition;
    if (!beaten) continue;

    const impressions = impressionsByQuery.get(query) ?? 0;
    if (impressions < MIN_IMPRESSIONS) continue; // only queries with real search demand

    const priorPosition = priorByQueryDomain.get(`${query}::${topCompetitor.domain}`) ?? null;
    candidates.push({ query, ownPosition, topCompetitor, impressions, priorPosition });
  }

  candidates.sort((a, b) => b.impressions - a.impressions);
  const priorities = priorityByRank(candidates);

  return candidates.map((c, i) => {
    const priority = priorities[i];
    const trend = c.priorPosition != null ? c.priorPosition - c.topCompetitor.position : null; // positive = competitor climbing
    return makeFinding({
      id: `competitor-intelligence:ranking:${c.query}:${c.topCompetitor.domain}`,
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
}
