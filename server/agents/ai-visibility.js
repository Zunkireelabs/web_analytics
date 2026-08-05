import { analyzePageUrl, checkLlmsReadiness, checkWebMcpPresence, effortForGenerator, inferSchemaType } from './lib/page-content.js';
import { getQueriesForPage } from '../store/read.js';
import { scorePageCategories, scoreLlmsReadiness, combineScores, geoSignalsScore } from './lib/visibility-score.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'ai-visibility',
  name: 'AI Visibility Agent',
  description: 'Scores how ready each ranking page is to be cited by AI answer engines (schema, FAQ, entities, structured content, citation readiness, LLMS readiness).',
  category: 'geo',
  version: 4, // bumped: facts now also carries webMcpReadiness (a new
              // site-level fact, see checkWebMcpPresence in lib/page-content.js
              // and webMcpFinding below) — a pre-v4 row has no such field.
  // Whether a page is ACTUALLY cited in AI Overviews/ChatGPT/Perplexity still
  // has no real data source — unchanged from v1, that remains unverifiable
  // here. This version answers a different, buildable question instead: is
  // the page structurally ready to be cited, based on real, deterministic
  // signals from the page's own fetched HTML plus the site's own robots.txt/
  // llms.txt.
  dataSources: [
    { id: 'ai-citation-tracking', status: 'not-connected', description: 'Citation tracking across AI answer engines — needed to know if a page is ACTUALLY cited, not just structurally ready' },
    { id: 'serp-ai-overview', status: 'not-connected', description: 'SERP API AI Overview presence detection' },
  ],
};

const MAX_PAGES = 20;

// Each rule's generatorId is set here, at the point the recommendation
// vocabulary is defined — not guessed downstream from the label text later.
// null = a real, worthwhile recommendation with no matching draft generator
// today (a structural fix, not content to draft).
const RECOMMENDATION_RULES = [
  // schemaScore only ever produces {0,25,50,75,100} (schemaTypes.length * 25)
  // — <=50 (not <50) so exactly 2 schema types still gets the "add more"
  // nudge instead of silently passing at the halfway point.
  { test: (c) => c.schema <= 50, label: 'Add schema markup (e.g. Article, Product, or Organization as relevant to the page).', generatorId: 'schema' },
  // structuredContentScore only ever produces {0,33,34,66,67,100} — the label
  // requires all three of H1/H2/list-or-table, so "not 100" is the correct
  // condition, not an arbitrary 67 cutoff that misses both 2-of-3 states that
  // land on exactly 67 (H1+H2 no list, or H1+list no H2).
  { test: (c) => c.structuredContent < 100, label: 'Fix heading structure: exactly one H1, add H2 subheadings, and add a list or table.', generatorId: null },
  { test: (c) => c.faq === 0, label: 'Add an FAQ section.', generatorId: 'faq' },
  { test: (c) => c.faq > 0 && c.faq < 100, label: 'Convert the existing FAQ into FAQPage schema so it\'s machine-readable.', generatorId: 'faq' },
  { test: (c) => c.entities < 70, label: 'Add entity schema (Organization, Product, Person, or LocalBusiness) to help AI engines identify what/who the page is about.', generatorId: 'schema' },
  // Retired 2026-08-03: citationReadiness < 60 used to recommend
  // expand-content's 'qa-subheadings' focus — bare question-form
  // subheadings spliced straight into body copy via componentTemplates.
  // expandContent (or the zero-CSS DEFAULT_EXPAND_TEMPLATE). In production
  // this rendered as a second, visually inconsistent Q&A pattern next to the
  // site's real FAQ accordion (no "Frequently asked questions" heading, no
  // collapse, different typography) — confusing on any page since it looked
  // like a broken/mismatched FAQ rather than a deliberate distinct feature.
  // Low citationReadiness is still surfaced (see visibility-score.js's
  // citationReadinessScore, part of siteScore.categories), just no longer
  // turned into its own separate content-generation recommendation — a page
  // lacking extractable Q&A content should get a real FAQ instead, which the
  // faq rules above already cover.
];

// llms.txt/robots readiness is a SITE-WIDE fact (one checkLlmsReadiness() call
// per run, shared by every page — see `llmsReadiness` in run() below), not a
// per-page signal. It used to live in RECOMMENDATION_RULES and get re-tested
// inside the per-page loop, which emitted one duplicate "Publish an llms.txt
// file..." finding per analyzed page — up to MAX_PAGES near-identical rows in
// Action Center, all resolving to the exact same generated draft since the
// generator only ever reads site-level facts anyway. Built once, after all
// pages are scored, from the same real hasLlmsTxt/robotsAllowsAiCrawlers
// ground truth the old per-page rule checked.
const LLMS_TXT_LABEL = 'Publish an llms.txt file and update robots.txt to explicitly allow AI answer-engine crawlers (GPTBot, ClaudeBot, PerplexityBot).';
const LLMS_TXT_KEY_PAGES_LIMIT = 8;

function llmsTxtFinding({ llmsReadiness, prioritized, priorities, start, end }) {
  if (!llmsReadiness || (llmsReadiness.hasLlmsTxt && llmsReadiness.robotsAllowsAiCrawlers !== false)) return null;
  const topPages = prioritized.slice(0, LLMS_TXT_KEY_PAGES_LIMIT).map((p) => p.page);
  // prioritized/priorities are already worst-score-first — the same ranking
  // every per-page finding's priority is drawn from, so this stays on the
  // same scale rather than inventing a separate one.
  const priority = priorities[0] || 'medium';
  return makeFinding({
    id: 'ai-visibility:site:llms-txt',
    evidence: {
      analyzedPages: prioritized.length,
      hasLlmsTxt: llmsReadiness.hasLlmsTxt,
      robotsAllowsAiCrawlers: llmsReadiness.robotsAllowsAiCrawlers,
      topPages,
    },
    whyItMatters: `Site-wide: ${!llmsReadiness.hasLlmsTxt ? 'no llms.txt file found' : 'robots.txt blocks one or more AI answer-engine crawlers'}. This affects AI-citation readiness across all ${prioritized.length} analyzed page(s), not just one.`,
    priority,
    recommendedAction: { label: LLMS_TXT_LABEL, generatorId: 'llms-txt', params: { priorityPages: topPages, start, end }, effort: effortForGenerator('llms-txt') },
    expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: prioritized.reduce((s, p) => s + p.impressions, 0) },
  });
}

function recommendationsFor(categories) {
  return RECOMMENDATION_RULES.filter((r) => r.test(categories)).map(({ label, generatorId }) => ({ label, generatorId }));
}

// WebMCP is genuinely optional and forward-looking (low real-world adoption
// today, unlike llms.txt) — always 'low' priority regardless of traffic at
// stake, and never carries a recommendedAction: generating a real manifest
// requires knowing this site's actual invocable actions, which no signal
// here can honestly derive (see checkWebMcpPresence in lib/page-content.js).
// This finding exists purely to inform, not to drive a draft.
export function webMcpFinding({ webMcpReadiness, analyzedCount }) {
  if (!webMcpReadiness || webMcpReadiness.hasManifest) return null;
  return makeFinding({
    id: 'ai-visibility:site:webmcp',
    evidence: { analyzedPages: analyzedCount, hasManifest: false },
    whyItMatters: 'No WebMCP manifest (/.well-known/mcp.json) found — an emerging, low-adoption standard that lets AI browsing agents call real site actions (e.g. "add to cart", "submit a form") directly instead of simulating clicks. Optional and forward-looking, not required today.',
    priority: 'low',
    recommendedAction: null,
    expectedImpact: { label: 'Low', basis: 'estimate', value: null },
  });
}

export async function run({ siteId, start, end, pageCache }) {
  // Falls back to a direct (uncached) fetch when run standalone, outside an
  // orchestrated run — keeps this agent independently runnable/testable
  // with identical output either way (see lib/fetch-cache.js).
  const fetchPage = pageCache || analyzePageUrl;
  // Merges real GSC top pages with the site-wide page inventory (sitemap +
  // crawl, see agents/lib/site-discovery.js) so this agent isn't limited to
  // only pages that already have search traffic — a brand-new or orphaned
  // page gets scored too, just rotated in over time rather than checked
  // every single run. Scoring itself never depends on GSC metrics (purely
  // the page's own fetched HTML structure), so a zero-traffic page scores
  // identically to a high-traffic one.
  const { batch, impressionsByPage } = await selectCandidatePages(siteId, 'ai-visibility', { start, end, batchSize: MAX_PAGES });

  // Real per-page top query — grounds the FAQ generator's own required
  // query/topic param the same way content-gap.js already does, instead of
  // relying entirely on recommendations.js's downstream fallback lookup.
  const fetched = await Promise.all(batch.map(async (page) => ({
    page,
    impressions: impressionsByPage.get(page) || 0,
    result: await fetchPage(page),
    topQuery: (await getQueriesForPage(siteId, start, end, page, 1))[0]?.query || '',
  })));
  await markPagesChecked(siteId, 'ai-visibility', batch);

  // Site-level LLMS readiness: one fetch per run, derived from the first
  // page that resolved to a real hostname — not repeated per page.
  let origin = null;
  for (const f of fetched) {
    if (f.result.ok) {
      try { origin = new URL(f.page).origin; break; } catch { /* try next page */ }
    }
  }
  const [llmsReadiness, webMcpReadiness] = origin
    ? await Promise.all([checkLlmsReadiness(origin), checkWebMcpPresence(origin)])
    : [null, null];
  const llmsScore = llmsReadiness ? scoreLlmsReadiness(llmsReadiness) : null;

  const pages = fetched.map((f) => {
    const base = { page: f.page, impressions: f.impressions, topQuery: f.topQuery, schemaTypes: f.result.ok ? f.result.analysis.schemaTypes : [] };
    if (!f.result.ok) return { ...base, score: null, fetchError: f.result.error };
    const categories = scorePageCategories(f.result.analysis);
    const scored = llmsScore != null ? combineScores(categories, llmsScore, geoSignalsScore(f.result.analysis)) : { overall: null, categories };
    return { ...base, score: scored, recommendations: recommendationsFor(scored.categories), fetchError: null };
  });

  const scoredPages = pages.filter((p) => p.score?.overall != null);
  const siteScore = scoredPages.length
    ? {
      overall: Math.round(scoredPages.reduce((s, p) => s + p.score.overall, 0) / scoredPages.length),
      categories: ['schema', 'structuredContent', 'faq', 'entities', 'citationReadiness', 'llmsReadiness'].reduce((acc, cat) => {
        acc[cat] = Math.round(scoredPages.reduce((s, p) => s + p.score.categories[cat], 0) / scoredPages.length);
        return acc;
      }, {}),
    }
    : null;

  // Prioritized: worst score first, real impressions as the tiebreaker so a
  // low-scoring high-traffic page outranks a low-scoring near-zero one.
  const prioritized = [...scoredPages].sort((a, b) => a.score.overall - b.score.overall || b.impressions - a.impressions);

  // `prioritized` is already worst-score-first with impressions as tiebreak
  // — the exact ranking a findings priority should follow (worst readiness +
  // most traffic at stake = most urgent to fix first).
  const priorities = priorityByRank(prioritized);
  const findings = prioritized.flatMap((p, i) => {
    if (!p.recommendations?.length) return [];
    const priority = priorities[i];
    const expectedImpact = { label: impactFromPriority(priority), basis: 'computed', value: p.impressions };
    return p.recommendations.map((rec) => makeFinding({
      id: `ai-visibility:${p.page}:${rec.label}`,
      evidence: { page: p.page, score: p.score.overall, impressions: p.impressions },
      whyItMatters: `AI Visibility score ${p.score.overall}/100 for this page (${p.impressions} impressions).`,
      priority,
      recommendedAction: {
        label: rec.label,
        generatorId: rec.generatorId,
        // faq.js needs a real query/topic (schemaType is secondary there —
        // only used to steer utility-page FAQs like Contact/About away from
        // generic brand content, see generators/faq.js) — everything else
        // keeps the page+schemaType shape schema.js actually consumes.
        params: rec.generatorId === 'faq'
          ? { page: p.page, query: p.topQuery, schemaType: inferSchemaType(p.page, p.schemaTypes) }
          : { page: p.page, schemaType: inferSchemaType(p.page, p.schemaTypes) },
        effort: effortForGenerator(rec.generatorId),
      },
      expectedImpact,
    }));
  });

  const siteFinding = llmsTxtFinding({ llmsReadiness, prioritized, priorities, start, end });
  if (siteFinding) findings.push(siteFinding);
  const webMcpSiteFinding = webMcpFinding({ webMcpReadiness, analyzedCount: prioritized.length });
  if (webMcpSiteFinding) findings.push(webMcpSiteFinding);

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    siteScore,
    llmsReadiness,
    webMcpReadiness,
    pages: prioritized,
    findings,
    unanalyzedCount: pages.length - scoredPages.length,
    note: 'Category and overall scores are computed only from real, verifiable signals on the page\'s own fetched ' +
      'HTML (or the site\'s own robots.txt/llms.txt for llmsReadiness) — never estimated. This measures structural ' +
      'readiness to be cited by an AI answer engine, not actual citation, which has no connected data source.',
  };

  const system = 'You are an AEO (answer-engine optimization) strategist writing for a non-technical site owner. ' +
    'Given a site-wide AI Visibility Score, its category breakdown (schema, structured content, FAQ, entities, ' +
    'citation readiness, LLMS readiness — each 0-100, all computed from real page/site data), and `pages`, a list ' +
    'already sorted worst-score-first (with impressions only as a tiebreaker between equal scores), write 3-4 ' +
    'sentences: state the site score, name the weakest category, then pick your 1-2 example pages ONLY from the ' +
    'first 2-3 entries of the `pages` array as given — do NOT pick a page based on its impressions alone if it is ' +
    'not near the top of that array, since a high-impression page can still have a good score. State each example ' +
    'page\'s own score and its top recommendation. Use ONLY the numbers given. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 350 })
    .catch((err) => { console.warn('[agents] ai-visibility narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
