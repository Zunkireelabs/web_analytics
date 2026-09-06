import { getCompetitorRankingDates, getCompetitorRankingsOn, getSearchPerformanceRange } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { runCompetitorDiscovery, normalizeCompetitorDomain, isKnownPlatformDomain } from './lib/competitor-analysis.js';
import { buildBacklinkComparison } from './lib/competitor-backlinks.js';
import { upsertCompetitorProfile, insertCompetitorStructuralSnapshot } from '../store/competitor-profiles.js';
import { getCompetitorProvider, competitorProviderConfigured } from '../ingest/competitor-providers/index.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'competitor-intelligence',
  name: 'Competitor Intelligence Agent',
  description: 'Identifies real competitors by combining two lenses — real Google rankings when a SERP provider is configured, and AI market-research reasoning grounded in the site\'s own business content — compares content/SEO/AEO positioning against them, and enriches with live keyword rankings and free Common Crawl referring-domain data.',
  category: 'seo',
  version: 6,
  dataSources: [
    {
      id: 'serp-competitor-discovery', status: competitorProviderConfigured() ? 'connected' : 'not-connected',
      description: 'Real Google organic SERP rankings via DataForSEO or the free Google Custom Search provider — who actually ranks for this site\'s own top queries, tallied across queries. A keyword-overlap signal; a true market competitor may not appear here at all.',
    },
    { id: 'llm-competitor-discovery', status: 'connected', description: 'AI market-research reasoning grounded in this site\'s own homepage content (industry, services, geography) — identifies real business/marketplace competitors, not just keyword overlap. Always runs alongside SERP discovery when available; a domain both agree on is the highest-confidence result.' },
    { id: 'commoncrawl-backlinks', status: 'connected', description: 'Free referring-domain counts and graph rank from Common Crawl\'s public web graph (server/providers/backlinks/commoncrawl.js) — no credentials required, always attempted. Supplements, never replaces, the paid DataForSEO-backed Authority Score.' },
  ],
};

const MIN_IMPRESSIONS = 5;

// One real number to rank discovered competitors by, strongest evidence
// first, so priorityByRank has a genuine signal to bucket on instead of the
// flat 'medium' every discovery finding used to carry.
//
// The ordering is deliberately evidence-strength before magnitude: a domain
// both lenses agree on outranks one only real Google rankings found, which
// outranks anything an LLM named on its own — and among LLM-only candidates,
// the ones whose homepage actually covers this site's own real search queries
// (queryRelevanceOverlap, free, no SERP provider needed) outrank the ones
// that cover none of them. The structural score gap only breaks ties within
// a tier; it can't promote an ungrounded guess above a confirmed competitor,
// which is the whole point — a real-but-irrelevant company the model recalled
// must never be presented as this site's most urgent competitive threat.
const DISCOVERY_CONFIDENCE_WEIGHT = { both: 1200, serp: 1000, llm: 0, forced: 0 };
const QUERY_OVERLAP_WEIGHT = 100;
function discoveryConfidence(c) {
  const source = DISCOVERY_CONFIDENCE_WEIGHT[c.discoverySource] ?? 0;
  const overlap = (c.queryOverlap?.overlapCount || 0) * QUERY_OVERLAP_WEIGHT;
  const scoreGap = (c.competitorScore ?? 0) - (c.ownScore ?? 0); // -100..100, tiebreak only
  return source + overlap + scoreGap;
}

export async function run({ siteId, start, end, params }) {
  // Always-available path: LLM discovers real competitors, crawls them,
  // compares structural signals — never blocked on external SEO API
  // credentials existing. See lib/competitor-analysis.js. params.competitor
  // (validated/normalized here, never trusted from the caller as-is) forces
  // one specific domain into this run even if discovery wouldn't have
  // surfaced it — see the agentic tool-calling loop's competitor-intelligence
  // tool.
  const forceDomain = normalizeCompetitorDomain(params?.competitor);
  const discovery = await runCompetitorDiscovery(siteId, start, end, { forceDomain });
  const reached = discovery.competitors.filter((c) => c.ok);
  const unreachable = discovery.competitors.filter((c) => !c.ok);

  // One timestamp shared by every domain this run identifies — lets
  // store/competitor-profiles.js select "this run's" competitors by exact
  // equality instead of a time-window heuristic (see its comment).
  const runAt = new Date();
  await Promise.all(reached.map((c) =>
    upsertCompetitorProfile(
      siteId, c.domain,
      { ...c.comparison, ownScore: c.ownScore, competitorScore: c.competitorScore, discoverySource: c.discoverySource, queryOverlap: c.queryOverlap },
      runAt,
      isKnownPlatformDomain(c.domain) ? 'platform' : null,
    ).catch((err) => console.error(`[agents] competitor-intelligence: failed to save profile for ${c.domain}:`, err.message))
  ));
  // Real, insert-only history alongside the overwrite-per-domain profile
  // above — same run, same scores, just appended instead of overwritten
  // (see migration 034 / store/competitor-profiles.js).
  await Promise.all(reached.map((c) =>
    insertCompetitorStructuralSnapshot(siteId, c.domain, c.competitorScore, c.ownScore, runAt)
      .catch((err) => console.error(`[agents] competitor-intelligence: failed to save structural snapshot for ${c.domain}:`, err.message))
  ));

  // Evidence carries ONLY real numbers/booleans about this competitor — the
  // two structural scores, the real structural signals crawled off its
  // homepage, how the domain was actually discovered, and the free
  // query-overlap grounding. It used to `...c.comparison` the whole parsed
  // LLM object in, so positioning/contentDepth/seoStructure/aiVisibility/
  // verdict — paragraphs of model commentary — were presented to a customer
  // in the one field types.js defines as "the specific real numbers backing
  // this finding". That prose still exists, in facts.comparisons and in the
  // narrative below, where it is plainly prose and not evidence.
  const discoveryCandidates = [...reached].sort((a, b) => discoveryConfidence(b) - discoveryConfidence(a));
  const discoveryPriorities = priorityByRank(discoveryCandidates);
  const discoveryFindings = discoveryCandidates.map((c, i) => {
    const overlap = c.queryOverlap || { queriesChecked: 0, overlapCount: 0, matchedQueries: [] };
    const serpVerified = c.discoverySource === 'serp' || c.discoverySource === 'both';
    const priority = discoveryPriorities[i];
    return makeFinding({
      id: `competitor-intelligence:discovery:${c.domain}`,
      evidence: {
        domain: c.domain, ownScore: c.ownScore, competitorScore: c.competitorScore,
        scoreGap: c.competitorScore != null && c.ownScore != null ? c.competitorScore - c.ownScore : null,
        discoverySource: c.discoverySource, serpVerified,
        queriesChecked: overlap.queriesChecked, queryOverlapCount: overlap.overlapCount,
        matchedQueries: overlap.matchedQueries,
        structuralSignals: c.comparison?.structuralSignals ?? null,
      },
      // Says out loud how this domain was actually found. A competitor
      // nobody's real rankings confirmed is AI market-research recall, and
      // saying so is the difference between evidence and an assertion.
      whyItMatters: serpVerified
        ? `${c.domain} really ranks on Google for this site's own tracked queries, and scores ${c.competitorScore}/100 structurally versus this site's ${c.ownScore}/100.`
        : `${c.domain} was named by AI market-research reasoning, not confirmed by any real ranking data (no SERP provider is connected). Its homepage covers ${overlap.overlapCount} of the ${overlap.queriesChecked} tracked quer${overlap.queriesChecked === 1 ? 'y' : 'ies'} this site actually gets searches for, and it scores ${c.competitorScore}/100 structurally versus this site's ${c.ownScore}/100.`,
      // Ranked by discoveryConfidence below — real ranking confirmation
      // first, then free query-overlap grounding, then the structural score
      // gap. Never the flat 'medium' constant this used to hardcode
      // (types.js: priority is "computed per agent from a real signal
      // already in facts — never a fixed constant").
      priority,
      recommendedAction: null,
      // 'estimate', not 'computed': even with the grounding above, "this
      // company is a competitor worth acting on" is a judgment, not a
      // measurement. The structural score gap is the real number behind it.
      expectedImpact: {
        label: impactFromPriority(priority),
        basis: 'estimate',
        value: c.competitorScore != null && c.ownScore != null ? c.competitorScore - c.ownScore : null,
      },
    });
  });

  // Enrichment path: real keyword-level "who outranks us" findings, only
  // produced when a SERP provider is actually configured and has real
  // ranking data (see ingest/competitors.js's weekly check) — additive on
  // top of the always-available discovery findings above, never blocking.
  // `checked` (separate from an empty findings array) lets facts.rankingComparison
  // below tell "never checked" apart from "checked, nobody outranks you" —
  // the latter is good news, not missing data.
  const { checked: rankingChecked, findings: rankingFindings } = await buildRankingFindings(siteId, start, end);

  // Free Common Crawl backlink comparison — additive, no credentials
  // required, never blocks the agent. Stays 'insufficient-data' at its own
  // level (never fabricated) when the site's own domain or every competitor
  // is absent from the Common Crawl dataset; see lib/competitor-backlinks.js.
  const backlinkComparison = await buildBacklinkComparison(discovery.ownDomain, reached.map((c) => c.domain));
  const backlinkFindings = buildBacklinkFindings(discovery.ownDomain, backlinkComparison);

  // Real Google-SERP "who outranks you" comparison — deliberately never a
  // 0-100 score, only real query/domain/position/impressions facts (see
  // buildRankingFindings above). serpProviderConfigured/checked distinguish
  // "no SERP provider set up" from "configured but never checked yet" from
  // "checked, you currently lead" — three honestly different reasons `rows`
  // can be empty, never collapsed into one generic message.
  const serpProviderConfigured = competitorProviderConfigured();
  const rankingComparison = {
    source: getCompetitorProvider().id,
    serpProviderConfigured,
    checked: rankingChecked,
    status: rankingFindings.length ? 'ok' : 'insufficient-data',
    message: !serpProviderConfigured
      ? 'Needs a real Google SERP connection (DataForSEO or the free Google Custom Search provider) to check live rankings.'
      : !rankingChecked
        ? 'Real Google ranking checks run weekly — none completed for this site yet.'
        : rankingFindings.length ? null : 'No competitor currently outranks you on your tracked queries.',
    rows: rankingFindings.map((f) => f.evidence),
  };

  const findings = [...discoveryFindings, ...rankingFindings, ...backlinkFindings];
  const facts = {
    rangeStart: start, rangeEnd: end,
    ownDomain: discovery.ownDomain,
    backlinkComparison,
    rankingComparison,
    // Per-competitor, not a single run-wide value — 'both' (real Google
    // rankings agree with AI market-research reasoning) is the strongest
    // signal, 'serp' is keyword-verified only, 'llm' is market-knowledge
    // only. Surfaced to the UI so a reader always knows how each
    // competitor on the list was actually identified.
    discoverySource: reached.map((c) => ({ domain: c.domain, source: c.discoverySource })),
    competitorsIdentified: reached.map((c) => c.domain),
    competitorsUnreachable: unreachable.map((c) => ({ domain: c.domain, error: c.error })),
    // ownScore/competitorScore/structuralSignals/queryOverlap are real
    // computed values; positioning/contentDepth/seoStructure/aiVisibility/
    // verdict are LLM commentary on those same signals. Both are fine to
    // carry in `facts` (the narrative call below reads them), but only the
    // former ever belong in a Finding's `evidence` — see discoveryFindings.
    comparisons: reached.map((c) => ({ domain: c.domain, ownScore: c.ownScore, competitorScore: c.competitorScore, queryOverlap: c.queryOverlap, ...c.comparison })),
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
    'competitor SERP rankings on this site\'s own search queries and a free Common Crawl referring-domain ' +
    'comparison (facts.backlinkComparison), write 2-4 sentences: name the most notable real competitor and the ' +
    'single most actionable gap versus them, and if ranking or backlinkComparison data is present, name the most ' +
    'damaging real competitive loss by search demand or referring-domain gap. If you cite backlinkComparison, ' +
    'always label it as free Common Crawl data, distinct from any paid backlink data. If the competitor you name ' +
    'has discoverySource "llm" (see facts.discoverySource), you MUST say plainly that it was identified by AI ' +
    'market research and has not been confirmed against real Google ranking data — never present it as measured. ' +
    'Use ONLY the data given, ' +
    'never invent a competitor name or number not present in the facts. A lower search position is BETTER. ' +
    'Plain text, no markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 350 })
    .catch((err) => { console.warn('[agents] competitor-intelligence narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}

// Preserves the original ranking-based logic exactly (same relative-demand
// prioritization, same finding shape) as an optional enrichment layer on
// top of the always-available discovery findings above — real keyword-level
// "who outranks us" data whenever a SERP provider is configured and has
// checked this week (see ingest/competitors.js). Returns `checked: false`
// with zero cost when no ranking check has ever happened yet, distinct from
// `checked: true, findings: []` (a real check ran and found nobody
// outranking this site) — the caller needs to tell those apart.
async function buildRankingFindings(siteId, start, end) {
  const dates = await getCompetitorRankingDates(siteId, 2);
  if (!dates.length) return { checked: false, findings: [] };

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

  const findings = candidates.map((c, i) => {
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
  return { checked: true, findings };
}

// Turns lib/competitor-backlinks.js's structured comparison into real,
// evidence-backed findings — every whyItMatters explicitly labels Common
// Crawl as the (free) source so it's never mistaken for the paid DataForSEO
// data behind the Authority Score. Returns [] (never fabricated placeholder
// findings) when the comparison itself is insufficient-data.
function buildBacklinkFindings(ownDomain, bc) {
  if (bc.status !== 'ok') return [];
  const findings = [];

  if (bc.strongestProfile) {
    const s = bc.strongestProfile;
    const who = s.domain === ownDomain ? 'This site' : s.domain;
    findings.push(makeFinding({
      id: 'competitor-intelligence:backlinks:strongest',
      evidence: { domain: s.domain, referringDomains: s.referringDomains, graphRank: s.graphRank, graphRelease: s.graphRelease, source: 'commoncrawl' },
      whyItMatters: `${who} has the strongest real backlink profile among sites compared — ${s.referringDomains} referring domains per Common Crawl (free data, release ${s.graphRelease}).`,
      // Informational, not ranked by a single number the way the gap
      // findings below are — same flat-'medium' convention as
      // discoveryFindings above.
      priority: 'medium',
      recommendedAction: null,
      expectedImpact: { label: 'Medium', basis: 'computed', value: s.referringDomains },
    }));
  }

  // Real deficits only (competitors with more referring domains than the
  // site) — priority reflects each gap's real rank among this run's gaps,
  // largest first, same priorityByRank convention as every other agent.
  const gaps = [bc.largestGap, ...bc.opportunities].filter(Boolean);
  const priorities = priorityByRank(gaps);
  gaps.forEach((g, i) => {
    findings.push(makeFinding({
      id: `competitor-intelligence:backlinks:gap:${g.domain}`,
      evidence: { domain: g.domain, ownDomain, referringDomainGap: g.gap, graphRelease: g.graphRelease, source: 'commoncrawl' },
      whyItMatters: `${g.domain} has ${g.gap} more referring domain${g.gap === 1 ? '' : 's'} than ${ownDomain} per Common Crawl (free data, release ${g.graphRelease})${i === 0 && gaps.length > 1 ? ' — the largest real backlink gap among tracked competitors' : ''}.`,
      priority: priorities[i],
      recommendedAction: null,
      expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'computed', value: g.gap },
    }));
  });

  return findings;
}
