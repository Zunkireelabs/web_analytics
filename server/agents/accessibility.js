import { getSearchPerformanceForPages } from '../store/read.js';
import { makeFinding, aggregateSystemicFinding } from './lib/findings.js';
import { analyzePageUrl, effortForGenerator } from './lib/page-content.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'accessibility',
  name: 'Accessibility Agent',
  description: 'Checks real, statically-verifiable accessibility issues — missing form labels, unlabeled interactive elements, duplicate IDs, heading-structure skips, and a missing page-language attribute.',
  category: 'accessibility',
  version: 1,
  dataSources: [
    // Real, honest gap, not a fabricated pass: color contrast and computed
    // tap-target size need a rendering engine to compute actual on-screen
    // geometry/colors, which nothing in this codebase does today. Google
    // PageSpeed Insights' Lighthouse "accessibility" category would cover
    // this for real, but technical-seo.js's existing PSI integration only
    // requests category=performance — always 'not-connected' regardless of
    // PAGESPEED_API_KEY, since that key isn't used for this category today.
    { id: 'lighthouse-accessibility-audit', status: 'not-connected', description: 'Real color-contrast/computed-geometry checks via PageSpeed Insights\' Lighthouse accessibility category — not requested by any current integration.' },
  ],
};

const MAX_PAGES = 20;

export async function run({ siteId, start, end, pageCache, params }) {
  const { batch, impressionsByPage } = params?.pages?.length
    ? await getSearchPerformanceForPages(siteId, start, end, params.pages).then((rows) => ({
      batch: params.pages,
      impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
    }))
    : await selectCandidatePages(siteId, 'accessibility', { start, end, batchSize: MAX_PAGES });

  if (!batch.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'No page performance data yet to select pages from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const fetchPage = pageCache || analyzePageUrl;
  const fetched = await Promise.all(batch.map(async (page) => ({ page, result: await fetchPage(page) })));
  if (!params?.pages?.length) await markPagesChecked(siteId, 'accessibility', batch);

  const reachable = fetched.filter((r) => r.result.ok).map((r) => ({ page: r.page, analysis: r.result.analysis, impressions: impressionsByPage.get(r.page) || 0 }));

  // <html lang> is near-always a shared-template attribute — missing on one
  // page almost always means missing on every page, so this is reported as
  // one aggregated finding (how many of the real checked pages lack it),
  // not N near-identical per-page findings for the same root template issue.
  const missingLang = reachable.filter((r) => !r.analysis.htmlLang);
  const langFindings = missingLang.length ? [makeFinding({
    id: 'accessibility:missing-html-lang',
    evidence: { affectedCount: missingLang.length, checkedCount: reachable.length, samplePages: missingLang.slice(0, 5).map((r) => r.page) },
    whyItMatters: `${missingLang.length} of ${reachable.length} checked pages have no <html lang> attribute — screen readers can't reliably choose the right pronunciation/voice without it.`,
    priority: missingLang.length === reachable.length ? 'high' : 'medium',
    recommendedAction: {
      label: 'Set page language',
      generatorId: 'html-lang',
      // No explicit lang here — the generator resolves the real per-site
      // language itself (url_file_map.siteRoot.htmlLang, falling back to
      // 'en'), so this agent never has to guess/hardcode a language it has
      // no real signal for.
      params: {},
      effort: effortForGenerator('html-lang'),
    },
    expectedImpact: { label: missingLang.length === reachable.length ? 'High' : 'Medium', basis: 'computed', value: missingLang.length },
  })] : [];

  // These four can genuinely be page-specific (one broken contact form
  // doesn't mean every page's forms are broken) — but any of them can also
  // stem from one shared header/footer/nav component reused across the
  // whole site, so they're reported as "N of M checked pages" aggregates
  // rather than assumed sitewide the way missing-html-lang is above.
  function aggregatedFinding(field, idPrefix, describe) {
    const affected = reachable.filter((r) => r.analysis[field] > 0);
    return aggregateSystemicFinding({
      id: `accessibility:${idPrefix}`,
      affected,
      checkedCount: reachable.length,
      getPage: (r) => r.page,
      getImpressions: (r) => r.impressions,
      whyItMatters: (n, c) => describe(n, c),
      recommendedAction: null,
    });
  }

  const labelFinding = aggregatedFinding('formInputsMissingLabel', 'missing-label',
    (n, c) => `${n} of ${c} checked pages have a form input with no associated label (nor aria-label) — screen-reader users can't tell what to enter.`);
  const interactiveFinding = aggregatedFinding('emptyInteractiveElements', 'empty-interactive',
    (n, c) => `${n} of ${c} checked pages have a button/link with no accessible text (no visible text, aria-label, or title) — screen readers announce them as blank.`);
  const duplicateIdFinding = aggregatedFinding('duplicateIdCount', 'duplicate-id',
    (n, c) => `${n} of ${c} checked pages have an id attribute used more than once — breaks aria-labelledby/for references pointing at them.`);
  const headingSkipFinding = aggregatedFinding('headingLevelSkips', 'heading-skip',
    (n, c) => `${n} of ${c} checked pages have a heading structure that skips a level (e.g. H1 straight to H3, no H2) — screen-reader users navigating by heading level lose the section structure.`);

  const findings = [...langFindings, labelFinding, interactiveFinding, duplicateIdFinding, headingSkipFinding].filter(Boolean);

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    pagesChecked: reachable.length,
    pagesMissingLang: missingLang.length,
    findings,
  };

  const system = 'You are an accessibility specialist writing for a non-technical site owner. Given real, ' +
    'statically-verified accessibility issues (missing form labels, unlabeled buttons/links, duplicate IDs, ' +
    'heading-structure skips, missing page-language attribute), write 2-3 sentences naming the single most ' +
    'important real issue and one concrete next step. Use ONLY the data given, never invent a page or number not ' +
    'present in the facts. Plain text, no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
      .catch((err) => { console.warn('[agents] accessibility narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
