import { getSearchPerformanceForPages } from '../store/read.js';
import { makeFinding } from './lib/findings.js';
import { analyzePageUrl } from './lib/page-content.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'mobile-usability',
  name: 'Mobile Usability Agent',
  description: 'Checks real, statically-verifiable mobile-usability issues — a missing or misconfigured viewport meta tag, including patterns that block pinch-zoom.',
  // 'seo' rather than 'performance' — Lighthouse's own audit taxonomy groups
  // viewport/tap-target/font-size checks under its SEO category, and
  // 'performance' is kept reserved for a future Core-Web-Vitals-focused
  // agent so the two categories don't overlap in meaning.
  category: 'seo',
  version: 1,
  dataSources: [
    // Same honest gap as accessibility.js: tap-target sizing and legible
    // font size need a rendering engine to compute real on-screen geometry.
    // PageSpeed Insights' Lighthouse "seo" category audits both, but
    // technical-seo.js's existing PSI integration only requests
    // category=performance — always 'not-connected' regardless of
    // PAGESPEED_API_KEY, since that key isn't used for this category today.
    { id: 'lighthouse-mobile-audit', status: 'not-connected', description: 'Real tap-target-sizing/legible-font-size checks via PageSpeed Insights\' Lighthouse seo category — not requested by any current integration.' },
  ],
};

const MAX_PAGES = 20;

export async function run({ siteId, start, end, pageCache, params }) {
  const { batch, impressionsByPage } = params?.pages?.length
    ? await getSearchPerformanceForPages(siteId, start, end, params.pages).then((rows) => ({
      batch: params.pages,
      impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
    }))
    : await selectCandidatePages(siteId, 'mobile-usability', { start, end, batchSize: MAX_PAGES });

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
  if (!params?.pages?.length) await markPagesChecked(siteId, 'mobile-usability', batch);

  const reachable = fetched.filter((r) => r.result.ok).map((r) => ({ page: r.page, analysis: r.result.analysis, impressions: impressionsByPage.get(r.page) || 0 }));
  const sumImpressions = (pages) => pages.reduce((s, p) => s + (impressionsByPage.get(p.page) || 0), 0);

  // Viewport configuration is near-always a shared-template attribute — one
  // aggregated finding per real issue type (how many of the real checked
  // pages have it), not N near-identical per-page findings for the same
  // root template issue. Missing entirely is worse than present-but-wrong.
  const missingViewport = reachable.filter((r) => !r.analysis.hasViewportMeta);
  const wrongViewport = reachable.filter((r) => r.analysis.hasViewportMeta && !r.analysis.viewportHasDeviceWidth);
  const zoomBlocked = reachable.filter((r) => r.analysis.viewportBlocksZoom);

  const findings = [];
  if (missingViewport.length) {
    findings.push(makeFinding({
      id: 'mobile-usability:missing-viewport',
      evidence: { affectedCount: missingViewport.length, checkedCount: reachable.length, samplePages: missingViewport.slice(0, 5).map((r) => r.page) },
      whyItMatters: `${missingViewport.length} of ${reachable.length} checked pages have no viewport meta tag at all — mobile browsers fall back to rendering a desktop-width layout and scaling it down, which reads as broken/tiny on a phone.`,
      priority: missingViewport.length === reachable.length ? 'high' : 'medium',
      recommendedAction: null,
      expectedImpact: { label: missingViewport.length === reachable.length ? 'High' : 'Medium', basis: 'computed', value: sumImpressions(missingViewport) },
    }));
  }
  if (wrongViewport.length) {
    findings.push(makeFinding({
      id: 'mobile-usability:misconfigured-viewport',
      evidence: { affectedCount: wrongViewport.length, checkedCount: reachable.length, samplePages: wrongViewport.slice(0, 5).map((r) => ({ page: r.page, content: r.analysis.viewportContent })) },
      whyItMatters: `${wrongViewport.length} of ${reachable.length} checked pages have a viewport tag that doesn't include "width=device-width" — a fixed-width viewport still forces the desktop-scaled-down layout mobile browsers are supposed to avoid.`,
      priority: 'medium',
      recommendedAction: null,
      expectedImpact: { label: 'Medium', basis: 'computed', value: sumImpressions(wrongViewport) },
    }));
  }
  if (zoomBlocked.length) {
    findings.push(makeFinding({
      id: 'mobile-usability:zoom-blocked',
      evidence: { affectedCount: zoomBlocked.length, checkedCount: reachable.length, samplePages: zoomBlocked.slice(0, 5).map((r) => ({ page: r.page, content: r.analysis.viewportContent })) },
      whyItMatters: `${zoomBlocked.length} of ${reachable.length} checked pages block pinch-to-zoom (user-scalable=no or maximum-scale<=1) — a real accessibility and usability problem for low-vision users, not just a missed best practice.`,
      priority: 'high',
      recommendedAction: null,
      expectedImpact: { label: 'High', basis: 'computed', value: sumImpressions(zoomBlocked) },
    }));
  }

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    pagesChecked: reachable.length,
    pagesMissingViewport: missingViewport.length,
    pagesWithWrongViewport: wrongViewport.length,
    pagesBlockingZoom: zoomBlocked.length,
    findings,
  };

  const system = 'You are a mobile UX specialist writing for a non-technical site owner. Given real, statically-' +
    'verified viewport configuration issues found across this site\'s own pages, write 2-3 sentences naming the ' +
    'single most important real issue and one concrete next step (a viewport meta tag fix). Use ONLY the data ' +
    'given, never invent a page or number not present in the facts. Plain text, no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
      .catch((err) => { console.warn('[agents] mobile-usability narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
