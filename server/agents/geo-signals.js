import { getQueriesForPage } from '../store/read.js';
import { analyzePageUrl, checkLlmsReadiness } from './lib/page-content.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { effortForGenerator, inferSchemaType } from './lib/page-content.js';

export const meta = {
  id: 'geo-signals',
  name: 'GEO Signals Agent',
  description: 'Checks ranking pages for Generative Engine Optimization signals (author attribution, content freshness, comparison content, external citations, review schema) that AI engines weigh when deciding what to cite.',
  category: 'geo',
  version: 1,
  dataSources: [
    { id: 'page-content-fetch', status: 'connected', description: 'Real page HTML fetched and analyzed for GEO signals — deterministic, verifiable checks' },
  ],
};

const MAX_PAGES = 20;

const GEO_SIGNAL_RULES = [
  {
    test: (analysis) => !analysis.hasAuthorSignal,
    label: 'Add author/byline markup (schema author field or visible byline) so AI engines attribute the content.',
    generatorId: 'expand-content',
    params: (page, query, schemaTypes) => ({ page, query, focus: 'author-byline' }),
    effort: 'Low',
  },
  {
    test: (analysis) => !analysis.hasFreshnessSignal,
    label: 'Add publish or last-updated date (datePublished/dateModified schema, article meta tag, or visible <time> element).',
    generatorId: 'expand-content',
    params: (page, query, schemaTypes) => ({ page, query, focus: 'freshness-date' }),
    effort: 'Low',
  },
  {
    test: (analysis) => !analysis.hasComparisonContent,
    label: 'Add comparison, alternatives, or "best of" content — generative engines disproportionately cite this shape.',
    generatorId: 'expand-content',
    params: (page, query, schemaTypes) => ({ page, query, focus: 'comparison-content' }),
    effort: 'Medium',
  },
  {
    test: (analysis) => !analysis.hasExternalCitations,
    label: 'Cite external authoritative sources within the page content — AI assistants favor well-sourced content.',
    generatorId: 'expand-content',
    params: (page, query, schemaTypes) => ({ page, query, focus: 'external-citations' }),
    effort: 'Low',
  },
  {
    test: (analysis) => !analysis.hasReviewSchema,
    label: 'Add Review or AggregateRating JSON-LD schema so AI assistants can surface social proof.',
    generatorId: 'schema',
    params: (page, query, schemaTypes) => ({ page, schemaType: 'Review' }),
    effort: 'Low',
  },
];

function recommendationsFor(analysis, page, query, schemaTypes) {
  return GEO_SIGNAL_RULES.filter((r) => r.test(analysis)).map((r) => ({
    label: r.label,
    generatorId: r.generatorId,
    params: r.params(page, query, schemaTypes),
    effort: r.effort,
  }));
}

export async function run({ siteId, start, end, pageCache }) {
  const fetchPage = pageCache || analyzePageUrl;
  const { batch, impressionsByPage } = await selectCandidatePages(siteId, 'geo-signals', { start, end, batchSize: MAX_PAGES });

  const fetched = await Promise.all(batch.map(async (page) => {
    const result = await fetchPage(page);
    const queries = await getQueriesForPage(siteId, start, end, page, 1);
    const topQuery = queries[0]?.query || '';
    const perf = impressionsByPage.get(page) || 0;
    return { page, impressions: perf, result, topQuery };
  }));

  await markPagesChecked(siteId, 'geo-signals', batch);

  let origin = null;
  for (const f of fetched) {
    if (f.result.ok) {
      try { origin = new URL(f.page).origin; break; } catch { }
    }
  }
  const llmsReadiness = origin ? await checkLlmsReadiness(origin) : null;

  const pages = fetched.map((f) => {
    const base = { page: f.page, impressions: f.impressions, topQuery: f.topQuery, schemaTypes: f.result.ok ? f.result.analysis.schemaTypes : [] };
    if (!f.result.ok) return { ...base, score: null, fetchError: f.result.error };
    const categories = recommendationsFor(f.result.analysis, f.page, f.topQuery, base.schemaTypes);
    return { ...base, recommendations: categories, fetchError: null };
  });

  const pagesWithRecs = pages.filter((p) => p.recommendations?.length);
  const prioritized = [...pagesWithRecs].sort((a, b) => a.recommendations.length - b.recommendations.length || b.impressions - a.impressions);
  const priorities = priorityByRank(prioritized);

  const findings = prioritized.flatMap((p, i) => {
    if (!p.recommendations?.length) return [];
    const priority = priorities[i];
    const expectedImpact = { label: impactFromPriority(priority), basis: 'computed', value: p.impressions };
    return p.recommendations.map((rec) => makeFinding({
      id: `geo-signals:${p.page}:${rec.label}`,
      evidence: { page: p.page, impressions: p.impressions, signalCount: p.recommendations.length },
      whyItMatters: `Missing ${p.recommendations.length} GEO signal(s) on this page (${p.impressions} impressions).`,
      priority,
      recommendedAction: {
        label: rec.label,
        generatorId: rec.generatorId,
        params: rec.params,
        effort: rec.effort,
      },
      expectedImpact,
    }));
  });

  const siteFinding = llmsReadiness && (!llmsReadiness.hasLlmsTxt || llmsReadiness.robotsAllowsAiCrawlers === false)
    ? makeFinding({
        id: 'geo-signals:site:llms-txt',
        evidence: { hasLlmsTxt: llmsReadiness.hasLlmsTxt, robotsAllowsAiCrawlers: llmsReadiness.robotsAllowsAiCrawlers },
        whyItMatters: `Site-wide: ${!llmsReadiness.hasLlmsTxt ? 'no llms.txt file found' : 'robots.txt blocks one or more AI answer-engine crawlers'}. This affects AI-citation readiness across all analyzed pages.`,
        priority: 'medium',
        recommendedAction: {
          label: 'Publish an llms.txt file and update robots.txt to explicitly allow AI answer-engine crawlers (GPTBot, ClaudeBot, PerplexityBot).',
          generatorId: 'llms-txt',
          params: { priorityPages: prioritized.slice(0, 8).map((p) => p.page), start, end },
          effort: effortForGenerator('llms-txt'),
        },
        expectedImpact: { label: 'Medium', basis: 'computed', value: prioritized.reduce((s, p) => s + p.impressions, 0) },
      })
    : null;

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    pages: prioritized,
    findings: [...findings, ...(siteFinding ? [siteFinding] : [])],
    note: 'GEO signals are deterministic checks against each page\'s real fetched HTML — author attribution, content freshness, comparison content, external citations, and review schema. These are the specific signals generative engines weigh when deciding what content to cite.',
  };

  return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
}