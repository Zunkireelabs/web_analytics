import { getSiteById, getSearchPerformanceRange, getTopPagePerQuery } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { analyzePageUrl } from './lib/page-content.js';
import { knownDomain, ownDomains, filterOwnDomainPages } from './lib/site-domain.js';
import { sortByRotation } from './lib/rotation.js';
import {
  upsertTrackedQuery, listActiveQueries, upsertQueryStatus,
  getCheckedAtForQueries, recordGrowthQueryCheck, getRecentChecks,
  listDraftedQueries, getLatestAiMentionForQueries,
} from '../store/growth-queries.js';
import { upsertTrackedPrompt } from '../store/ai-recommendation.js';
import { configured as googleCseConfigured, fetchRankings as fetchGoogleCseRankings } from '../ingest/competitor-providers/google-cse.js';
import { getConfiguredProviders } from './lib/model-providers/index.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { effortForGenerator } from './lib/page-content.js';
import { callLLM } from '../llm.js';

// Generalizes ai-recommendation.js's discover-track-probe-verify shape to
// REAL, evidence-grounded search queries (its own GSC data plus LLM
// expansion grounded in the site's real content) instead of LLM-hypothesized
// buyer prompts — this agent asks "what does this site's real category
// actually get searched for, and do we answer it," ai-recommendation.js asks
// "does a real AI assistant recommend us for a buyer question." Distinct id,
// distinct question, no capability overlap (registry.js throws on
// duplicate ids anyway).
export const meta = {
  id: 'growth-queries',
  name: 'Growth Query Discovery',
  category: 'geo',
  // Missing until now — agent_runs.agent_version is NOT NULL, so every real
  // run of this agent succeeded (it always returned real findings) but
  // runner.js's saveAgentRun() silently failed on the constraint violation
  // (caught and only console.error'd, never surfacing to a caller). The
  // agent worked; its run history just never got written, which is why it
  // showed "Never run" in the Agent Taskforce despite real weekly/on-demand
  // runs happening the whole time.
  version: 1,
  description: 'Discovers the real range of search/AI-assistant queries this site\'s category gets asked, checks whether the site\'s own content directly answers each one, and tracks whether newly-covered gaps actually start showing up in Google or AI assistants over time.',
  dataSources: [
    { id: 'gsc-query-data', status: 'connected', description: 'Real Google Search Console query/impression/position data for this site — the primary discovery signal.' },
    { id: 'llm-category-expansion', status: 'connected', description: 'LLM-reasoned expansion into broad category, niche, comparison, and question-style queries, grounded only in this site\'s own real services/pages/queries — never invented.' },
    { id: 'google-cse-presence-check', status: googleCseConfigured() ? 'connected' : 'not-connected', description: 'Google Custom Search spot-check for whether this site\'s own domain appears for a newly-targeted query — a free-tier top-10 SERP snapshot, NOT a full rank-tracking API. Requires GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX.' },
    { id: 'ai-mention-check', status: getConfiguredProviders().length ? 'connected' : 'not-connected', description: 'Reads ai-recommendation.js\'s own already-probed AI-assistant results for queries this agent seeded — no duplicate probing.' },
  ],
};

const GSC_DISCOVERY_LIMIT = 200; // a wider net than opportunity.js's own 100-query pull, since this agent also needs queries well outside striking distance
const MIN_GSC_IMPRESSIONS = 5;
const GSC_CANDIDATE_CAP = 40; // bounds the LLM classification call
const LLM_PROPOSAL_CAP = 25;
const TOP_N_FOR_TRACTION = 20; // "does this site already have real traction" — same top-N a site's own real GSC data would call meaningful
const COVERAGE_BATCH_SIZE = 30; // rotated over time via sortByRotation, same discipline as candidate-pages.js/ai-recommendation.js
const VERIFY_BATCH_SIZE = 20;
const PAGE_MATCH_CANDIDATE_CAP = 4; // real page fetches per query when checking coverage — bounded, cached across queries in the same run
const COVERED_OVERLAP_THRESHOLD = 0.75; // most of the query's real terms present in the page's own real title/description/body
const PARTIAL_OVERLAP_THRESHOLD = 0.34; // roughly a third — topically adjacent, not a direct answer
const FINDINGS_CAP = 15;
const AI_PROBE_SEED_CAP = 10;
// Excludes opportunity.js's own striking-distance window (position 5-15) so
// the two agents never emit near-duplicate findings for the same query —
// opportunity.js already owns "ranking just off page 1"; this agent only
// looks at queries ranking well beyond that, or with no page attribution in
// GSC's own data at all.
const STRIKING_DISTANCE_MAX = 15;

// Exported (alongside termOverlap/urlSlugOverlap/findCoveringPage below) so
// the deterministic, no-DB/no-network parts of this agent have real unit
// test coverage (see growth-queries.test.js) without needing a live DB —
// same pattern as ai-recommendation.js's exported computeProviderFacts/etc.
export function isNewRow(row) {
  return !!row && row.first_seen_at?.getTime?.() === row.last_seen_at?.getTime?.();
}

export function termOverlap(haystack, queryText) {
  const terms = queryText.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return 0;
  const hay = haystack.toLowerCase();
  return terms.filter((t) => hay.includes(t)).length / terms.length;
}

export function urlSlugOverlap(url, queryText) {
  let path = '';
  try { path = new URL(url).pathname; } catch { path = String(url); }
  return termOverlap(path.toLowerCase().replace(/[-_/]+/g, ' '), queryText);
}

// Deterministic, no-extra-API-call coverage check: prefers the page GSC
// itself already associates with this query, then a small set of
// path-slug-similar inventory pages, fetching+analyzing only the bounded
// candidate set (cached across queries in the same run via `analysisFor`).
// `analysisFor` is injected (not imported directly) so this is testable with
// a fake page-content map, no real fetch.
export async function findCoveringPage(queryText, directPage, inventoryUrls, analysisFor) {
  const preRanked = inventoryUrls
    .map((url) => ({ url, slugOverlap: urlSlugOverlap(url, queryText) }))
    .sort((a, b) => b.slugOverlap - a.slugOverlap)
    .slice(0, PAGE_MATCH_CANDIDATE_CAP - 1)
    .map((r) => r.url);
  const candidates = [...new Set([directPage, ...preRanked].filter(Boolean))];

  let best = { coverageStatus: 'missing', page: null, overlap: 0 };
  for (const url of candidates) {
    const result = await analysisFor(url);
    if (!result.ok) continue;
    const haystack = `${result.analysis.title} ${result.analysis.metaDescription} ${result.analysis.bodyText || ''}`;
    const overlap = termOverlap(haystack, queryText);
    if (overlap > best.overlap) {
      best = {
        coverageStatus: overlap >= COVERED_OVERLAP_THRESHOLD ? 'covered' : overlap >= PARTIAL_OVERLAP_THRESHOLD ? 'partial' : 'missing',
        page: url, overlap,
      };
    }
  }
  return best;
}

// Single LLM call doing two things at once (one real call, not two): (1)
// proposes new real-phrasing queries grounded ONLY in the given real site
// context — broad category, niche, comparison, "how do I", and follow-up
// questions — same non-fabrication discipline as ai-recommendation.js's
// generatePromptCandidates; (2) classifies EVERY query given (both its own
// proposals and the real GSC candidates handed in) as 'broad-category' or
// 'niche' RELATIVE TO THIS SITE'S OWN real niche — never a fixed word-count
// rule, so the same call generalizes across any industry.
async function expandAndClassify({ companyName, homepageTitle, homepageDescription, topPages, topQueries, candidateTexts }) {
  const system = 'You are a search-visibility strategist. Using ONLY the real company context given below — never invent ' +
    'a service, industry, or fact not evidenced in it — do two things. First, propose additional realistic queries real ' +
    'people might search on Google or ask an AI assistant about this company\'s real category: broad category terms, ' +
    'niche/specific terms, comparison queries ("X vs Y"), "how do I" problem queries, and natural follow-up questions. ' +
    'Second, classify the SPECIFICITY of every query below — both your own proposals and the real candidate queries given ' +
    '— relative to THIS company\'s real niche: "broad-category" (a generic industry/category term this specific company ' +
    'has no real claim to win outright) or "niche" (specific enough to this company\'s real offerings to be a realistic ' +
    'target). Respond with ONLY a JSON object: {"proposed": [{"queryText": "...", "queryType": "llm-category"|' +
    '"llm-comparison"|"llm-question", "specificity": "broad-category"|"niche"}], "candidateSpecificity": ' +
    `[{"queryText": "...", "specificity": "broad-category"|"niche"}]}, "proposed" capped at ${LLM_PROPOSAL_CAP} items, ` +
    '"candidateSpecificity" covering every real candidate query given.';
  const user = `Company: ${companyName}\nHomepage title: ${homepageTitle || 'unknown'}\n` +
    `Homepage description: ${homepageDescription || 'unknown'}\nTop pages: ${topPages.join(', ') || 'none'}\n` +
    `Top queries: ${topQueries.join(', ') || 'none'}\nReal candidate queries to classify: ${candidateTexts.join(', ') || 'none'}`;
  const raw = await callLLM(system, user, { maxTokens: 1400 }).catch(() => null);
  if (!raw) return { proposed: [], specificityByText: new Map() };
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const proposed = (Array.isArray(parsed.proposed) ? parsed.proposed : [])
      .filter((p) => p && typeof p.queryText === 'string' && ['llm-category', 'llm-comparison', 'llm-question'].includes(p.queryType))
      .slice(0, LLM_PROPOSAL_CAP);
    const specificityByText = new Map();
    for (const p of proposed) if (p.specificity) specificityByText.set(p.queryText, p.specificity);
    for (const c of (Array.isArray(parsed.candidateSpecificity) ? parsed.candidateSpecificity : [])) {
      if (c && typeof c.queryText === 'string' && ['broad-category', 'niche'].includes(c.specificity)) {
        specificityByText.set(c.queryText, c.specificity);
      }
    }
    return { proposed, specificityByText };
  } catch {
    return { proposed: [], specificityByText: new Map() };
  }
}

async function checkFlippedToFound(siteId, queryId, checkType) {
  const map = await getRecentChecks(siteId, [queryId], checkType, 2);
  const rows = map.get(queryId) || [];
  if (rows.length < 2) return false;
  return !!rows[0].found && !rows[1].found;
}

export async function run({ siteId, start, end }) {
  const site = await getSiteById(siteId);
  const domain = knownDomain(site);

  // ---- Phase 1: discover ----
  const [gscQueriesRaw, topPagesRaw, topPageByQueryRows] = await Promise.all([
    getSearchPerformanceRange(siteId, start, end, 'query', GSC_DISCOVERY_LIMIT),
    getSearchPerformanceRange(siteId, start, end, 'page', 8),
    getTopPagePerQuery(siteId, start, end),
  ]);
  const topPages = filterOwnDomainPages(topPagesRaw, ownDomains(site)).map((p) => p.dim_value);
  const pageByQuery = new Map(topPageByQueryRows.map((p) => [p.query, p.page]));
  const top20ByImpressions = new Set(
    [...gscQueriesRaw].sort((a, b) => Number(b.impressions) - Number(a.impressions)).slice(0, TOP_N_FOR_TRACTION).map((q) => q.dim_value)
  );

  const gscCandidates = gscQueriesRaw
    .filter((q) => Number(q.impressions) >= MIN_GSC_IMPRESSIONS)
    .filter((q) => q.avg_position == null || Number(q.avg_position) > STRIKING_DISTANCE_MAX)
    .sort((a, b) => Number(b.impressions) - Number(a.impressions))
    .slice(0, GSC_CANDIDATE_CAP)
    .map((q) => ({
      queryText: q.dim_value,
      impressions: Number(q.impressions),
      queryType: pageByQuery.get(q.dim_value) ? 'gsc-near-miss' : 'gsc-uncovered',
    }));

  const homepage = topPages[0] ? await analyzePageUrl(topPages[0]).catch(() => ({ ok: false })) : { ok: false };
  const { proposed, specificityByText } = await expandAndClassify({
    companyName: site?.name || 'This company',
    homepageTitle: homepage.ok ? homepage.analysis.title : null,
    homepageDescription: homepage.ok ? homepage.analysis.metaDescription : null,
    topPages, topQueries: [...top20ByImpressions],
    candidateTexts: gscCandidates.map((c) => c.queryText),
  });

  const gscUpserted = await Promise.all(gscCandidates.map((c) =>
    upsertTrackedQuery(siteId, c.queryText, c.queryType, 'gsc').catch((err) => { console.error('[agents] growth-queries: failed to upsert gsc query:', err.message); return null; })));
  const llmUpserted = await Promise.all(proposed.map((p) =>
    upsertTrackedQuery(siteId, p.queryText, p.queryType, 'llm').catch((err) => { console.error('[agents] growth-queries: failed to upsert llm query:', err.message); return null; })));
  const newQueryCount = [...gscUpserted, ...llmUpserted].filter(isNewRow).length;

  const active = await listActiveQueries(siteId);
  if (!active.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'No real query candidates could be derived yet — needs at least one real page/query for this site.',
      generatedAt: new Date().toISOString(),
    };
  }

  // ---- Phase 2: check coverage on a rotated batch ----
  const checkedAt = await getCheckedAtForQueries(siteId, active.map((q) => q.id));
  const rotatedIds = sortByRotation(active.map((q) => q.id), checkedAt);
  const byId = new Map(active.map((q) => [q.id, q]));
  const batch = rotatedIds.slice(0, COVERAGE_BATCH_SIZE).map((id) => byId.get(id));

  const inventory = filterOwnDomainPages(await listPageInventory(siteId, { limit: 500 }), ownDomains(site), (r) => r.page);
  const inventoryUrls = inventory.map((r) => r.page);
  const pageAnalysisCache = new Map();
  async function analysisFor(url) {
    if (pageAnalysisCache.has(url)) return pageAnalysisCache.get(url);
    const result = await analyzePageUrl(url).catch(() => ({ ok: false }));
    pageAnalysisCache.set(url, result);
    return result;
  }

  const checkedStatuses = [];
  for (const q of batch) {
    const gscRow = gscQueriesRaw.find((g) => g.dim_value === q.query_text);
    const impressions = gscRow ? Number(gscRow.impressions) : null;

    // Broad-term heuristic (niche-relative, not word-count): suppressed only
    // when the LLM judged it broad-category FOR THIS SITE'S OWN real niche
    // AND the site has no real traction for it yet (top-20 by impressions).
    // A query with real traction, or one judged niche-specific for this
    // site, is never suppressed — generalizes across industries since it
    // reasons about "broad relative to this site," not an absolute term list.
    const isBroadForThisSite = specificityByText.get(q.query_text) === 'broad-category';
    const hasRealTraction = top20ByImpressions.has(q.query_text);
    if (isBroadForThisSite && !hasRealTraction) {
      const status = await upsertQueryStatus(siteId, q.id, {
        coverageStatus: 'missing',
        incumbentNote: 'category-term-too-broad, see narrower variants',
      });
      checkedStatuses.push({ query: q, status, impressions, suppressed: true });
      continue;
    }

    const covering = await findCoveringPage(q.query_text, pageByQuery.get(q.query_text), inventoryUrls, analysisFor);
    const status = await upsertQueryStatus(siteId, q.id, {
      coverageStatus: covering.coverageStatus,
      coveredByPage: covering.page,
      incumbentNote: null,
    });
    checkedStatuses.push({ query: q, status, impressions, suppressed: false });
  }

  // ---- Phase 3: prioritize + draft-eligible findings ----
  const gaps = checkedStatuses.filter((c) => !c.suppressed && c.status.coverage_status !== 'covered');
  const rankedGaps = [...gaps].sort((a, b) => {
    const statusRank = (s) => (s === 'missing' ? 0 : 1);
    const statusDiff = statusRank(a.status.coverage_status) - statusRank(b.status.coverage_status);
    if (statusDiff !== 0) return statusDiff;
    return (b.impressions ?? -1) - (a.impressions ?? -1);
  }).slice(0, FINDINGS_CAP);
  const gapPriorities = priorityByRank(rankedGaps);
  const gapFindings = rankedGaps.map((g, i) => makeFinding({
    id: `growth-queries:gap:${g.query.id}`,
    evidence: { queryText: g.query.query_text, queryType: g.query.query_type, coverageStatus: g.status.coverage_status, impressions: g.impressions },
    whyItMatters: `"${g.query.query_text}" is a real, currently-${g.status.coverage_status === 'partial' ? 'only-partially-answered' : 'unanswered'} search${g.impressions ? ` with ${g.impressions} real impressions` : ' surfaced by category expansion'} — no page on this site directly answers it.`,
    priority: gapPriorities[i],
    recommendedAction: { label: `Cover: ${g.query.query_text}`, generatorId: 'direct-answer', params: { query: g.query.query_text, queryId: g.query.id, context: `Real ${g.query.query_type} gap, coverage_status=${g.status.coverage_status}.` }, effort: effortForGenerator('direct-answer') },
    expectedImpact: { label: impactFromPriority(gapPriorities[i]), basis: 'estimate', value: null },
  }));

  // Seeds ai-recommendation.js's own prompt universe with the top missing
  // queries so its EXISTING probe rotation covers them too — the query text
  // itself is used as the probe prompt (most GSC/llm-question/llm-comparison
  // queries already read as natural phrasing; this deliberately avoids a
  // second LLM rephrasing call for a cosmetic improvement).
  const topMissingForProbe = rankedGaps.filter((g) => g.status.coverage_status === 'missing').slice(0, AI_PROBE_SEED_CAP);
  await Promise.all(topMissingForProbe.map((g) =>
    upsertTrackedPrompt(siteId, g.query.query_text, 'growth-query', g.query.id)
      .catch((err) => console.error('[agents] growth-queries: failed to seed AI probe prompt:', err.message))));

  // ---- Phase 5: verify already-drafted queries ----
  const drafted = await listDraftedQueries(siteId);
  const verifyCheckedAt = await getCheckedAtForQueries(siteId, drafted.map((d) => d.query_id));
  const verifyBatch = sortByRotation(drafted.map((d) => d.query_id), verifyCheckedAt)
    .slice(0, VERIFY_BATCH_SIZE)
    .map((id) => drafted.find((d) => d.query_id === id));
  const aiMentionByQuery = await getLatestAiMentionForQueries(siteId, verifyBatch.map((d) => d.query_id));

  const verifiedFindings = [];
  for (const d of verifyBatch) {
    const signals = [];
    if (googleCseConfigured()) {
      try {
        const rankings = await fetchGoogleCseRankings(d.query_text);
        const match = domain ? rankings.find((r) => r.domain === domain) : null;
        await recordGrowthQueryCheck(siteId, d.query_id, {
          checkType: 'google-cse', found: !!match, position: match?.position ?? null,
          detail: { note: 'Google Custom Search spot-check — not a full rank-tracking API.' },
        });
        if (await checkFlippedToFound(siteId, d.query_id, 'google-cse')) signals.push('now appears in a Google Custom Search spot-check');
      } catch (err) {
        console.warn(`[agents] growth-queries: google-cse check failed for query ${d.query_id}:`, err.message);
      }
    }
    const nowShowing = gscQueriesRaw.find((q) => q.dim_value === d.query_text);
    await recordGrowthQueryCheck(siteId, d.query_id, {
      checkType: 'gsc-impressions', found: !!nowShowing, position: nowShowing ? Number(nowShowing.avg_position) : null, detail: null,
    });
    if (await checkFlippedToFound(siteId, d.query_id, 'gsc-impressions')) signals.push('now shows real Google Search Console impressions');

    const aiMention = aiMentionByQuery.get(d.query_id);
    if (aiMention?.mentioned) signals.push('now mentioned by a probed AI assistant');

    if (signals.length) {
      verifiedFindings.push(makeFinding({
        id: `growth-queries:verified:${d.query_id}`,
        evidence: { queryText: d.query_text, signals },
        whyItMatters: `"${d.query_text}" ${signals.join(' and ')} since content was drafted for it.`,
        priority: 'low',
        recommendedAction: null,
        expectedImpact: { label: 'Low', basis: 'computed', value: null },
      }));
    }
  }

  const findings = [...gapFindings, ...verifiedFindings];
  const facts = {
    rangeStart: start, rangeEnd: end,
    totalTracked: active.length, newThisCycle: newQueryCount,
    coverageChecked: checkedStatuses.length,
    missingCount: checkedStatuses.filter((c) => c.status.coverage_status === 'missing' && !c.suppressed).length,
    partialCount: checkedStatuses.filter((c) => c.status.coverage_status === 'partial').length,
    suppressedAsBroadCount: checkedStatuses.filter((c) => c.suppressed).length,
    verifiedCount: verifiedFindings.length,
    findings,
    note: 'Discovery combines real GSC query data with LLM-reasoned category/comparison/question expansion grounded ' +
      'only in this site\'s own real services/pages/queries. Coverage is a deterministic term-overlap check against a ' +
      'bounded set of real fetched pages, never an LLM judgment call. The broad-term suppression is relative to this ' +
      'site\'s own real niche and its own real GSC traction — never a fixed word-count rule. Google presence checks use ' +
      'a free Google Custom Search spot-check (top-10 snapshot), not a full rank-tracking API. AI-mention checks read ' +
      'ai-recommendation.js\'s own already-probed results — this agent never probes an AI provider itself.',
  };

  const system = 'You are a growth strategist writing for a non-technical site owner about real, currently-unanswered ' +
    'search queries in their category. Given real counts of newly-discovered queries, missing/partial coverage gaps, ' +
    'and any queries that have started showing up in Google or AI assistants since content was drafted, write 2-3 ' +
    'sentences summarizing the state of play. Use ONLY the numbers given, never invent a query or percentage not ' +
    'present in the facts. Plain text, no markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 300 })
    .catch((err) => { console.warn('[agents] growth-queries narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
