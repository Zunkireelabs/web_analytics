import { getSearchPerformanceRange } from '../store/read.js';
import { analyzePageUrl, checkLlmsReadiness, effortForGenerator } from './lib/page-content.js';
import { scorePageCategories, scoreLlmsReadiness, combineScores } from './lib/visibility-score.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'ai-visibility',
  name: 'AI Visibility Agent',
  description: 'Scores how ready each ranking page is to be cited by AI answer engines (schema, FAQ, entities, structured content, citation readiness, LLMS readiness).',
  category: 'geo',
  version: 2,
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
const MIN_IMPRESSIONS = 5;

// Each rule's generatorId is set here, at the point the recommendation
// vocabulary is defined — not guessed downstream from the label text later.
// null = a real, worthwhile recommendation with no matching draft generator
// today (a structural fix, not content to draft).
const RECOMMENDATION_RULES = [
  { test: (c) => c.schema < 50, label: 'Add schema markup (e.g. Article, Product, or Organization as relevant to the page).', generatorId: 'schema' },
  { test: (c) => c.structuredContent < 67, label: 'Fix heading structure: exactly one H1, add H2 subheadings, and add a list or table.', generatorId: null },
  { test: (c) => c.faq === 0, label: 'Add an FAQ section.', generatorId: 'faq' },
  { test: (c) => c.faq > 0 && c.faq < 100, label: 'Convert the existing FAQ into FAQPage schema so it\'s machine-readable.', generatorId: 'faq' },
  { test: (c) => c.entities < 70, label: 'Add entity schema (Organization, Product, Person, or LocalBusiness) to help AI engines identify what/who the page is about.', generatorId: 'schema' },
  { test: (c) => c.citationReadiness < 60, label: 'Add question-style subheadings (e.g. "What is...", "How does...") for direct-answer extraction.', generatorId: null },
];

function recommendationsFor(categories) {
  return RECOMMENDATION_RULES.filter((r) => r.test(categories)).map(({ label, generatorId }) => ({ label, generatorId }));
}

export async function run({ siteId, start, end }) {
  const pagePerf = await getSearchPerformanceRange(siteId, start, end, 'page', 100);
  const candidates = pagePerf
    .filter((p) => Number(p.impressions) >= MIN_IMPRESSIONS)
    .sort((a, b) => Number(b.impressions) - Number(a.impressions))
    .slice(0, MAX_PAGES);

  const fetched = await Promise.all(candidates.map(async (p) => ({
    page: p.dim_value,
    impressions: Number(p.impressions),
    clicks: Number(p.clicks),
    avgPosition: p.avg_position != null ? Number(p.avg_position) : null,
    result: await analyzePageUrl(p.dim_value),
  })));

  // Site-level LLMS readiness: one fetch per run, derived from the first
  // page that resolved to a real hostname — not repeated per page.
  let origin = null;
  for (const f of fetched) {
    if (f.result.ok) {
      try { origin = new URL(f.page).origin; break; } catch { /* try next page */ }
    }
  }
  const llmsReadiness = origin ? await checkLlmsReadiness(origin) : null;
  const llmsScore = llmsReadiness ? scoreLlmsReadiness(llmsReadiness) : null;

  const pages = fetched.map((f) => {
    const base = { page: f.page, impressions: f.impressions, clicks: f.clicks, avgPosition: f.avgPosition };
    if (!f.result.ok) return { ...base, score: null, fetchError: f.result.error };
    const categories = scorePageCategories(f.result.analysis);
    const scored = llmsScore != null ? combineScores(categories, llmsScore) : { overall: null, categories };
    return { ...base, score: scored, recommendations: recommendationsFor(categories), fetchError: null };
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
      recommendedAction: { label: rec.label, generatorId: rec.generatorId, params: { page: p.page, schemaType: 'Article' }, effort: effortForGenerator(rec.generatorId) },
      expectedImpact,
    }));
  });

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    siteScore,
    llmsReadiness,
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
