import { getQueriesForPage, getSearchPerformanceForPages } from '../store/read.js';
import { analyzePageUrl, contentGapsFor, GAP_TYPE_TO_GENERATOR, effortForGenerator, inferSchemaType } from './lib/page-content.js';
import { priorityByRank, impactFromPriority, makeFinding, aggregateSystemicFinding } from './lib/findings.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { listCompetitorProfiles } from '../store/competitor-profiles.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'content-gap',
  name: 'Content Gap Agent',
  description: 'Analyzes the site\'s own ranking pages for on-page completeness gaps, cross-references real tracked-competitor structural signals, and suggests possibly-missing entities.',
  category: 'content',
  version: 4,
  // True topical/SERP-based gap detection (a specific topic a competitor
  // ranks for that this site has no page for at all) still has no real data
  // source — that's a different, still-unbuilt question from what's below.
  // v3 added: real structural-signal cross-referencing against
  // competitor-intelligence's tracked competitors (FAQ/schema/comparison-
  // content presence, from their actual crawled homepages) — degrades
  // honestly to no competitive framing when competitor-intelligence hasn't
  // run yet or found fewer than 2 reachable competitors.
  // v4 adds: a real canonical-target check (not just tag presence) — flags
  // a canonical pointing at a different domain, the most common real-world
  // canonical mistake (see lib/page-content.js's contentGapChecks).
  dataSources: [
    { id: 'competitor-analysis', status: 'connected', description: 'Real structural signals (FAQ/schema/comparison-content presence) from competitor-intelligence\'s monthly crawl of tracked competitor homepages — used to note when most tracked competitors have a feature a page lacks. Needs at least 2 reachable competitor profiles to produce a meaningful ratio; degrades to no competitive framing otherwise, never fabricated.' },
    { id: 'serp-api', status: 'not-connected', description: 'SERP results for true topical gap detection (a specific topic/query a competitor ranks for that this site has no page for at all)' },
  ],
};

// Only gap types with a directly comparable structural signal from
// competitor-analysis.js's structuralSignals — headings/alt-text/canonical/
// OG/lists/question-headings have no competitor-side equivalent captured
// today, so they stay page-only findings rather than a forced comparison.
// ('Missing schema' is aggregated site-wide below, so it no longer goes
// through this per-page competitive framing.)
const GAP_TYPE_TO_COMPETITOR_SIGNAL = {
  'Missing FAQ': 'hasFaq',
  'Missing comparisons': 'hasComparisonContent',
};
const MIN_TRACKED_COMPETITORS = 2; // below this, a "X of Y" ratio isn't a real market signal

const MAX_PAGES = 20;
const MAX_AI_SUGGESTION_PAGES = 6; // bounds LLM cost — entity suggestions run only for the top-impression pages
const AI_SUGGESTION_MAX_ITEMS = 4;

// Reads the page's own text + its top real ranking query and asks the LLM
// to name likely-relevant subtopics the text doesn't seem to cover. This is
// explicitly an inference, never a verified fact — kept in its own field,
// never merged into the deterministic `gaps`, and always confidence-labeled.
async function suggestMissingEntities(bodyText, queryText) {
  if (!bodyText || !queryText) return { suggestions: [], error: 'no-context' };
  const system = 'You are an SEO/AEO content analyst. Given a real search query and a page\'s actual fetched ' +
    `text, suggest up to ${AI_SUGGESTION_MAX_ITEMS} specific subtopics or entities commonly expected for that ` +
    'query which the text does NOT appear to cover. This is your inference from reading the page, not a verified ' +
    'fact — never claim certainty, and if nothing clearly stands out, return fewer items or none. Respond with ' +
    'ONLY a JSON array (no prose, no markdown fences), each item shaped exactly as ' +
    '{"entity": "...", "confidence": "low"|"medium"|"high", "rationale": "one short sentence"}. If nothing stands out, respond with [].';
  const user = `Query: ${queryText}\n\nPage text (truncated): ${bodyText.slice(0, 3000)}`;
  const raw = await callLLM(system, user, { maxTokens: 400 }).catch(() => null);
  if (raw == null) return { suggestions: [], error: 'llm-call-failed' };
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed)) return { suggestions: [], error: 'unexpected-format' };
    const clean = parsed
      .filter((s) => s && typeof s.entity === 'string' && ['low', 'medium', 'high'].includes(s.confidence))
      .slice(0, AI_SUGGESTION_MAX_ITEMS);
    return { suggestions: clean, error: null };
  } catch {
    return { suggestions: [], error: 'parse-failed' };
  }
}

export async function run({ siteId, start, end, pageCache, params }) {
  // Falls back to a direct (uncached) fetch when run standalone, outside an
  // orchestrated run — keeps this agent independently runnable/testable
  // with identical output either way (see lib/fetch-cache.js).
  const fetchPage = pageCache || analyzePageUrl;
  // params.page (from the agentic tool-calling loop) bypasses the normal
  // rotation entirely and checks exactly that one page — the caller already
  // knows which page they care about, so there's no reason to make them wait
  // for it to come up in rotation. Real impressions still come from GSC, not
  // guessed; markPagesChecked is skipped below so this ad-hoc check doesn't
  // perturb the normal rotation order for every other page.
  const [{ batch, impressionsByPage }, competitorProfiles] = await Promise.all([
    params?.page
      ? getSearchPerformanceForPages(siteId, start, end, [params.page]).then((rows) => ({
        batch: [params.page],
        impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
      }))
      // Merges real GSC top pages with the site-wide page inventory (sitemap
      // + crawl) so a page with real content but no search traffic yet —
      // often exactly why it has no traffic — still gets checked, rotated in
      // over time rather than every run. getQueriesForPage legitimately
      // returns [] for a zero-traffic page; suggestMissingEntities already
      // degrades to its 'no-context' path when that happens, so no special-
      // casing needed here.
      : selectCandidatePages(siteId, 'content-gap', { start, end, batchSize: MAX_PAGES }),
    listCompetitorProfiles(siteId),
  ]);

  // Real aggregate across tracked competitors' actual crawled homepages —
  // older profiles from before this signal existed simply have no
  // structuralSignals and are excluded, rather than counted as "doesn't
  // have it" (that would be fabricating a negative from missing data).
  const trackedCompetitors = competitorProfiles.filter((p) => p.comparison?.structuralSignals);
  const competitorStats = trackedCompetitors.length >= MIN_TRACKED_COMPETITORS ? {
    total: trackedCompetitors.length,
    hasFaq: trackedCompetitors.filter((p) => p.comparison.structuralSignals.hasFaq).length,
    hasSchema: trackedCompetitors.filter((p) => p.comparison.structuralSignals.hasSchema).length,
    hasComparisonContent: trackedCompetitors.filter((p) => p.comparison.structuralSignals.hasComparisonContent).length,
  } : null;

  const analyzed = await Promise.all(batch.map(async (page) => {
    const [queries, fetched] = await Promise.all([
      getQueriesForPage(siteId, start, end, page, 3),
      fetchPage(page),
    ]);
    const topQueries = queries.map((q) => q.query);
    const base = {
      page,
      impressions: impressionsByPage.get(page) || 0,
      topQueries,
    };
    if (!fetched.ok) return { ...base, gaps: null, aiEligible: false, fetchError: fetched.error, _analysis: null };
    return {
      ...base,
      gaps: contentGapsFor(fetched.analysis, topQueries),
      aiEligible: true,
      fetchError: null,
      _analysis: fetched.analysis,
      _topQuery: topQueries[0] || '',
    };
  }));

  if (!params?.page) await markPagesChecked(siteId, 'content-gap', batch);

  // AI-inferred entity suggestions only for the top-impression pages that
  // fetched successfully — bounds LLM cost while still analyzing every
  // candidate page's deterministic gaps. `analyzed` is in rotation order,
  // not impression order (selectCandidatePages sorts by staleness so every
  // page gets checked over time) — sort by real impressions here so the
  // "bounded to top pages by impressions" claim below is actually true,
  // not just rotation order coincidentally correlating with it.
  const aiCandidates = analyzed.filter((r) => r.aiEligible)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, MAX_AI_SUGGESTION_PAGES);
  const aiResults = await Promise.all(aiCandidates.map(async (r) => ({
    page: r.page,
    ...(await suggestMissingEntities(r._analysis.bodyText, r._topQuery)),
  })));
  const aiByPage = new Map(aiResults.map((a) => [a.page, a]));

  const pages = analyzed.map((r) => {
    const { _analysis, _topQuery, aiEligible, ...rest } = r;
    const ai = aiByPage.get(r.page);
    return {
      ...rest,
      schemaTypes: _analysis?.schemaTypes || [],
      aiSuggestions: ai ? ai.suggestions : null,
      aiSuggestionsNote: ai?.error
        ? `AI suggestion generation failed (${ai.error}).`
        : (ai ? null : (aiEligible ? 'Not sampled for AI-inferred entity suggestions this run (bounded to the top pages by impressions).' : null)),
    };
  });

  // Priority = rank by real impressions among pages that actually have a gap
  // — the same relative-comparison approach used everywhere else in this
  // agent family, never an absolute impressions cutoff (which would be
  // meaningless across sites of very different traffic scale).
  const pagesWithGaps = pages.filter((p) => p.gaps?.length).sort((a, b) => b.impressions - a.impressions);
  const priorityByPage = new Map(priorityByRank(pagesWithGaps).map((pr, i) => [pagesWithGaps[i].page, pr]));

  // Schema/canonical/Open-Graph gaps are commonly a shared <head> template
  // issue (the template never emits JSON-LD/canonical/OG tags), not a
  // page-by-page authoring gap — aggregated into one finding per gap type
  // instead of one per page. Every other gap type stays per-page: it's
  // driven by that specific page's own authored content (headings, FAQ,
  // alt text, ...), not a shared template attribute.
  const AGGREGATED_GAP_TYPES = new Set(['Missing schema', 'Missing canonical tag', 'Missing Open Graph tags']);
  const analyzedPages = pages.filter((p) => p.gaps != null);
  const pagesWithGapType = (type) => analyzedPages.filter((p) => p.gaps.some((g) => g.type === type));

  const siteWideGapFindings = [
    aggregateSystemicFinding({
      id: 'content-gap:site:missing-schema',
      affected: pagesWithGapType('Missing schema'),
      checkedCount: analyzedPages.length,
      getPage: (p) => p.page,
      getImpressions: (p) => p.impressions,
      whyItMatters: (n, c) => `${n} of ${c} checked pages have no structured data (JSON-LD) on the page.`,
      recommendedAction: (rep) => ({
        label: 'Missing schema',
        generatorId: 'schema',
        params: { page: rep.page, query: rep.topQueries?.[0] || '', schemaType: inferSchemaType(rep.page, rep.schemaTypes) },
        effort: effortForGenerator('schema'),
      }),
    }),
    aggregateSystemicFinding({
      id: 'content-gap:site:missing-canonical',
      affected: pagesWithGapType('Missing canonical tag'),
      checkedCount: analyzedPages.length,
      getPage: (p) => p.page,
      getImpressions: (p) => p.impressions,
      whyItMatters: (n, c) => `${n} of ${c} checked pages have no rel="canonical" link.`,
      recommendedAction: (rep) => ({ label: 'Add canonical', generatorId: 'canonical', params: { page: rep.page }, effort: effortForGenerator('canonical') }),
    }),
    aggregateSystemicFinding({
      id: 'content-gap:site:missing-og',
      affected: pagesWithGapType('Missing Open Graph tags'),
      checkedCount: analyzedPages.length,
      getPage: (p) => p.page,
      getImpressions: (p) => p.impressions,
      whyItMatters: (n, c) => `${n} of ${c} checked pages have no og:title/og:description.`,
      recommendedAction: (rep) => ({ label: 'Add Open Graph tags', generatorId: 'open-graph', params: { page: rep.page }, effort: effortForGenerator('open-graph') }),
    }),
  ].filter(Boolean);

  const findings = [...siteWideGapFindings, ...pages.flatMap((p) => {
    const priority = priorityByPage.get(p.page) || 'low';
    const gapFindings = (p.gaps || []).filter((g) => !AGGREGATED_GAP_TYPES.has(g.type)).map((g) => {
      const generatorId = GAP_TYPE_TO_GENERATOR[g.type] ?? null;
      // Real competitive framing: only added when at least MIN_TRACKED_COMPETITORS
      // reachable competitor profiles exist AND most of them actually have
      // this exact signal — a majority-of-real-competitors bar, not "any
      // competitor has it" (one outlier shouldn't drive urgency).
      const signalKey = GAP_TYPE_TO_COMPETITOR_SIGNAL[g.type];
      const withSignal = signalKey && competitorStats ? competitorStats[signalKey] : null;
      const competitive = withSignal != null && withSignal / competitorStats.total > 0.5
        ? { withFeature: withSignal, total: competitorStats.total }
        : null;
      return makeFinding({
        id: `content-gap:${p.page}:${g.type}`,
        evidence: {
          page: p.page, impressions: p.impressions, gapType: g.type, detail: g.detail,
          ...(competitive ? { competitorsWithThisFeature: competitive.withFeature, competitorsTracked: competitive.total } : {}),
        },
        whyItMatters: competitive
          ? `${g.detail} ${competitive.withFeature} of ${competitive.total} tracked real competitors already have this.`
          : g.detail,
        priority,
        recommendedAction: generatorId
          ? { label: g.type, generatorId, params: { page: p.page, query: p.topQueries?.[0] || '', schemaType: inferSchemaType(p.page, p.schemaTypes) }, effort: effortForGenerator(generatorId) }
          : null,
        expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: p.impressions },
      });
    });
    const aiFindings = (p.aiSuggestions || []).map((s) => makeFinding({
      id: `content-gap:${p.page}:entity:${s.entity}`,
      evidence: { page: p.page, entity: s.entity, confidence: s.confidence },
      whyItMatters: `${s.rationale} (AI-suggested, confidence: ${s.confidence})`,
      // AI-inferred suggestions are never boosted past their own confidence
      // — a low-confidence guess on a high-traffic page stays low priority.
      priority: s.confidence === 'high' ? priority : 'low',
      recommendedAction: { label: `Cover: ${s.entity}`, generatorId: 'blog-outline', params: { topic: s.entity, context: `Related to existing page ${p.page}. ${s.rationale}` }, effort: effortForGenerator('blog-outline') },
      expectedImpact: { label: 'Low', basis: 'estimate', value: null },
    }));
    return [...gapFindings, ...aiFindings];
  })];

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    pages,
    count: pages.length,
    findings,
    // Null when fewer than MIN_TRACKED_COMPETITORS reachable competitor
    // profiles exist yet — an honest "not enough real data for a market
    // signal" state, not a zeroed-out stat that would misread as "no
    // competitors have this."
    competitorContext: competitorStats,
    note: 'gaps are deterministic checks against each page\'s real fetched HTML. Where a gap type has a directly ' +
      'comparable signal from tracked competitors\' own crawled homepages (FAQ/schema/comparison content) and a ' +
      'real majority of them have it, whyItMatters includes that "X of Y competitors" ratio — never fabricated, ' +
      'omitted entirely when fewer than 2 competitor profiles exist. aiSuggestions are LLM inferences from ' +
      'reading the page text, confidence-labeled, NOT verified facts — treat as a starting hypothesis. This ' +
      'agent only recommends; it never modifies any page.',
  };

  const system = 'You are a content strategist writing for a non-technical site owner, summarizing on-page ' +
    'completeness across the site\'s ranking pages. Given each page\'s deterministic gaps (verified from real ' +
    'fetched HTML — headings, FAQ, schema, comparisons, alt text, canonical, Open Graph, lists, question ' +
    'headings) and any confidence-labeled AI-suggested missing entities, write 3-4 sentences naming the highest-' +
    'impression pages with the most impactful gaps and the single most valuable fix each. ' +
    'Competitor mentions: ONLY mention competitors, and ONLY for a specific gap whose own whyItMatters text in ' +
    'the facts already contains the literal phrase "tracked real competitors already have this" — restate that ' +
    'exact real ratio (e.g. "3 of 4 tracked competitors") if it helps make the case, and lead with such a gap ' +
    'when one exists since it is more actionable. If no gap in the facts has that phrase, do not mention ' +
    'competitors at all — never say "competitors" in the abstract and never invent, name, or imply any specific ' +
    'competitor (no placeholder names like "X and Y" either) beyond that exact real ratio. ' +
    'If you mention an AI-suggested entity, say plainly that it is a suggestion with its confidence level — ' +
    'never state it as fact. This agent only recommends, it never modifies any page — don\'t imply otherwise. ' +
    'Use ONLY the numbers/data given. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 400 })
    .catch((err) => { console.warn('[agents] content-gap narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
