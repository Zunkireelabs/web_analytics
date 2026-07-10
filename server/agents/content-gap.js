import { getSearchPerformanceRange, getQueriesForPage } from '../store/read.js';
import { analyzePageUrl, contentGapsFor } from './lib/page-content.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'content-gap',
  name: 'Content Gap Agent',
  description: 'Analyzes the site\'s own ranking pages for on-page completeness gaps and suggests possibly-missing entities.',
  category: 'content',
  version: 2,
  // True competitive gap detection (topics competitors cover that this site
  // doesn't at all) still has no real data source — unchanged from v1. This
  // version covers a different, buildable question instead: is each of THIS
  // site's own ranking pages structurally complete on the checks below.
  dataSources: [
    { id: 'competitor-analysis', status: 'not-connected', description: 'Competitor content/ranking data — needed to find topics competitors cover that this site does not at all' },
    { id: 'serp-api', status: 'not-connected', description: 'SERP results for topical gap detection' },
  ],
};

const MAX_PAGES = 20;
const MAX_AI_SUGGESTION_PAGES = 6; // bounds LLM cost — entity suggestions run only for the top-impression pages
const MIN_IMPRESSIONS = 5;
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

export async function run({ siteId, start, end }) {
  const pagePerf = await getSearchPerformanceRange(siteId, start, end, 'page', 100);
  const candidates = pagePerf
    .filter((p) => Number(p.impressions) >= MIN_IMPRESSIONS)
    .sort((a, b) => Number(b.impressions) - Number(a.impressions))
    .slice(0, MAX_PAGES);

  const analyzed = await Promise.all(candidates.map(async (p) => {
    const page = p.dim_value;
    const [queries, fetched] = await Promise.all([
      getQueriesForPage(siteId, start, end, page, 3),
      analyzePageUrl(page),
    ]);
    const topQueries = queries.map((q) => q.query);
    const base = {
      page,
      impressions: Number(p.impressions),
      clicks: Number(p.clicks),
      avgPosition: p.avg_position != null ? Number(p.avg_position) : null,
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

  // AI-inferred entity suggestions only for the top-impression pages that
  // fetched successfully — bounds LLM cost while still analyzing every
  // candidate page's deterministic gaps.
  const aiCandidates = analyzed.filter((r) => r.aiEligible).slice(0, MAX_AI_SUGGESTION_PAGES);
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
      aiSuggestions: ai ? ai.suggestions : null,
      aiSuggestionsNote: ai?.error
        ? `AI suggestion generation failed (${ai.error}).`
        : (ai ? null : (aiEligible ? 'Not sampled for AI-inferred entity suggestions this run (bounded to the top pages by impressions).' : null)),
    };
  });

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    pages,
    count: pages.length,
    note: 'gaps are deterministic checks against each page\'s real fetched HTML. aiSuggestions are LLM ' +
      'inferences from reading the page text, confidence-labeled, NOT verified facts — treat as a starting ' +
      'hypothesis. This agent only recommends; it never modifies any page.',
  };

  const system = 'You are a content strategist writing for a non-technical site owner, summarizing on-page ' +
    'completeness across the site\'s ranking pages. Given each page\'s deterministic gaps (verified from real ' +
    'fetched HTML — headings, FAQ, schema, comparisons, alt text, canonical, Open Graph, lists, question ' +
    'headings) and any confidence-labeled AI-suggested missing entities, write 3-4 sentences naming the highest-' +
    'impression pages with the most impactful gaps and the single most valuable fix each. If you mention an AI-' +
    'suggested entity, say plainly that it is a suggestion with its confidence level — never state it as fact. ' +
    'This agent only recommends, it never modifies any page — don\'t imply otherwise. Use ONLY the numbers/data ' +
    'given. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 400 })
    .catch((err) => { console.warn('[agents] content-gap narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
