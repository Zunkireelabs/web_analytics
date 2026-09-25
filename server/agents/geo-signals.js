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

// Raised from 20 — see content-gap.js's MAX_PAGES comment for the full
// reasoning (merge-sync fix + 800+ open recommendations backlog on
// Zunkiree Labs meant the scan rate, not the ship ceiling, was the real
// bottleneck). This agent's only per-page cost is a page-content fetch, no
// external per-page quota to respect.
const MAX_PAGES = 40;

// A "missing author signal" rule used to live here, routing to
// expand-content's author-byline focus. Retired platform-wide (2026-09-24,
// explicit owner decision): that focus no longer drafts a visible "About
// the Author" section for any site (see expand-content.js), so routing a
// recommendation there would only ever produce a dead-end, permanently-
// failing draft. Schema-level author attribution (rel="author",
// itemprop="author", Article schema's author field) is unaffected — still
// surfaced separately as an informational gap by
// page-content.js's summarizeContentGaps, and still fixable via the
// 'schema' action type — this only removes the visible-section
// recommendation.
const GEO_SIGNAL_RULES = [
  {
    // Routed to 'schema' (datePublished/dateModified JSON-LD), NOT
    // expand-content's 'freshness-date' focus — that focus drafts a VISIBLE
    // "Last Updated" heading + sentence as its own EXPANDEDCONTENT section.
    // AI engines and Google both read dateModified from structured data or a
    // real <time>/meta tag just as well as visible prose, so a stray
    // "Last Updated" block bolted onto the page (confirmed live on site 8864,
    // chayceproperties.com, 2026-09-20 — shipped on 6+ pages, several with no
    // styling at all) bought no real GEO/SEO benefit for a very visible cost.
    // schema.js's DATE_FIELD_RE already auto-fills datePublished/dateModified
    // with today's real date on every schema draft, so this loses nothing —
    // it's the same real fact, invisible.
    test: (analysis) => !analysis.hasFreshnessSignal,
    label: 'Add publish or last-updated date via schema (datePublished/dateModified JSON-LD) — invisible structured data, not a visible on-page block.',
    generatorId: 'schema',
    params: (page, query, schemaTypes) => ({ page, schemaType: inferSchemaType(page, schemaTypes) }),
    effort: effortForGenerator('schema'),
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
    // Deliberately informational (generatorId: null), unlike the other four
    // rules above — those route to 'schema' or expand-content with a `focus`
    // that generator can always honestly satisfy (a real date, the site's own
    // configured author, a grounded external source). Review schema has no equivalent
    // safe default: schema.js's Review type needs real ratingValue/
    // reviewCount data that most pages simply never have (a blog post, a
    // careers page), so it can't fill this gap without fabricating and
    // (correctly) refuses instead — via the Article-fallback-blocked path
    // once the page already has real Article schema, which is true for
    // nearly every content page. routed here as 'schema'/'Review', that
    // refusal is not a one-off: hasReviewSchema can never become true
    // without real review data appearing on the page, so the SAME
    // recommendation refused on repeat, day after day (confirmed live on
    // site 1 — the same handful of Review-schema recommendations refusing
    // since Aug 14), burning attempts and contributing to
    // auto-remediation.js's consecutive-refusal breaker before it reached
    // genuinely shippable work. content-gap.js's GAP_TYPE_TO_GENERATOR
    // (page-content.js) already reached this same conclusion for the
    // identical gap ('Missing review/rating schema': null) — this just
    // brings this file's own copy of the same signal in line with it.
    test: (analysis) => !analysis.hasReviewSchema,
    label: 'Add Review or AggregateRating JSON-LD schema so AI assistants can surface social proof — only once this page has real reviews/ratings to mark up.',
    generatorId: null,
    params: () => ({}),
    effort: 'Low',
  },
  {
    test: (analysis) => analysis.questionHeadingCount === 0,
    label: 'Add question-style headings (e.g. "What is...?", "How does...?") with grounded answers — improves featured-snippet and AI-citation eligibility.',
    generatorId: 'qa-content',
    params: (page, query, schemaTypes) => ({ page, query }),
    effort: 'Low',
  },
];

export function recommendationsFor(analysis, page, query, schemaTypes) {
  return GEO_SIGNAL_RULES.filter((r) => r.test(analysis)).map((r) => ({
    label: r.label,
    generatorId: r.generatorId,
    params: r.params(page, query, schemaTypes),
    effort: r.effort,
  }));
}

export async function run({ siteId, start, end, pageCache, params }) {
  const fetchPage = pageCache || analyzePageUrl;
  // params.pages bypasses the daily rotation for an on-demand single-page
  // recheck (recommendation-coordinator.js's manual recheck action) — same
  // pattern as technical-seo.js/security-headers.js.
  const { batch, impressionsByPage } = params?.pages?.length
    ? { batch: params.pages, impressionsByPage: new Map() }
    : await selectCandidatePages(siteId, 'geo-signals', { start, end, batchSize: MAX_PAGES });

  const fetched = await Promise.all(batch.map(async (page) => {
    const result = await fetchPage(page);
    const queries = await getQueriesForPage(siteId, start, end, page, 1);
    const topQuery = queries[0]?.query || '';
    const perf = impressionsByPage.get(page) || 0;
    return { page, impressions: perf, result, topQuery };
  }));

  if (!params?.pages?.length) await markPagesChecked(siteId, 'geo-signals', batch);

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

  const llmsMissing = llmsReadiness && !llmsReadiness.hasLlmsTxt;
  const llmsBlockedByRobots = llmsReadiness && llmsReadiness.robotsAllowsAiCrawlers === false;
  const llmsMalformed = llmsReadiness && llmsReadiness.hasLlmsTxt && !llmsReadiness.hasValidLlmsTxtStructure;
  const siteFinding = (llmsMissing || llmsBlockedByRobots || llmsMalformed)
    ? makeFinding({
        id: 'geo-signals:site:llms-txt',
        evidence: { hasLlmsTxt: llmsReadiness.hasLlmsTxt, hasValidLlmsTxtStructure: llmsReadiness.hasValidLlmsTxtStructure, robotsAllowsAiCrawlers: llmsReadiness.robotsAllowsAiCrawlers },
        whyItMatters: `Site-wide: ${llmsMissing ? 'no llms.txt file found' : llmsMalformed ? 'llms.txt exists but is missing the required "# Title" heading and/or markdown links' : 'robots.txt blocks one or more AI answer-engine crawlers'}. This affects AI-citation readiness across all analyzed pages.`,
        priority: 'medium',
        recommendedAction: {
          label: llmsMalformed && !llmsMissing && !llmsBlockedByRobots
            ? 'Fix llms.txt to follow the convention: a top-level "# Site Name" heading, a short description, and markdown links to key pages.'
            : 'Publish an llms.txt file and update robots.txt to explicitly allow AI answer-engine crawlers (GPTBot, ClaudeBot, PerplexityBot).',
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
    checkedPages: batch, // this run's rotation batch — see security-headers.js facts for why
    findings: [...findings, ...(siteFinding ? [siteFinding] : [])],
    note: 'GEO signals are deterministic checks against each page\'s real fetched HTML — author attribution, content freshness, comparison content, external citations, and review schema. These are the specific signals generative engines weigh when deciding what content to cite.',
  };

  return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
}