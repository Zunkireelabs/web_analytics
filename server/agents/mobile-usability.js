import { getSearchPerformanceForPages } from '../store/read.js';
import { makeFinding, aggregateSystemicFinding } from './lib/findings.js';
import { analyzePageUrl, effortForGenerator } from './lib/page-content.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { callLLM } from '../llm.js';
import { fetchMobileUsabilityAudit, configured as pagespeedConfigured } from '../ingest/pagespeed.js';
import { hasInlineFontSizeOverride } from './lib/font-consistency-analysis.js';

export const meta = {
  id: 'mobile-usability',
  name: 'Mobile Usability Agent',
  description: 'Checks real mobile-usability issues — a missing or misconfigured viewport meta tag (always), plus real tap-target-sizing and legible-font-size audits when PageSpeed Insights is configured.',
  // 'seo' rather than 'performance' — Lighthouse's own audit taxonomy groups
  // viewport/tap-target/font-size checks under its SEO category, and
  // 'performance' is kept reserved for a future Core-Web-Vitals-focused
  // agent so the two categories don't overlap in meaning.
  category: 'seo',
  version: 2,
  dataSources: [
    // Same honest gap as accessibility.js: tap-target sizing and legible
    // font size need a rendering engine to compute real on-screen geometry.
    // pagespeed.js's fetchMobileUsabilityAudit now requests PSI's Lighthouse
    // "seo" category for this (a second request from fetchCoreWebVitals's
    // own category=performance one — PSI does not return both categories'
    // full detail in one call). Connected exactly when PAGESPEED_API_KEY is
    // set — same key, same config surface as technical-seo.js's own CWV
    // check, no new env var.
    { id: 'lighthouse-mobile-audit', status: pagespeedConfigured() ? 'connected' : 'not-connected', description: 'Real tap-target-sizing/legible-font-size checks via PageSpeed Insights\' Lighthouse seo category.' },
  ],
};

// Finds the real Lighthouse-captured element (its outerHTML-equivalent
// "snippet") behind a font-size-too-small row that carries its OWN inline
// font-size override — the one shape font-consistency.js's own
// 'font-size-override' fixType already safely patches (see
// font-consistency-analysis.js's hasInlineFontSizeOverride/
// buildFontSizeOverrideRemoved: an exact-match-or-refuse single-element
// style-attribute edit, never a guess at a shared class/stylesheet rule).
// Tries every plausible Lighthouse node-details field name (real Lighthouse
// audits nest per-item node detail differently: tap-targets under
// `tapTarget`, other node-based audits under `node` or `source`) rather than
// assuming one exact shape — returns null (never guesses) when nothing
// snippet-shaped is found, which is a genuine "no safe fix available"
// result, not a bug.
function findSafeFontSizeOverrideElement(row) {
  const items = row?.audit?.fontSize?.failingElements || [];
  for (const item of items) {
    const snippet = item?.node?.snippet ?? item?.source?.snippet ?? item?.snippet ?? null;
    if (snippet && hasInlineFontSizeOverride(snippet)) return snippet;
  }
  return null;
}

const MAX_PAGES = 20;
// Lighthouse's own "average" cutoff — a score below this on either audit is
// a real, page-failing result, not a stylistic nitpick. Matches the
// 0.5/0.9 boundaries pagespeed.js's own categoryFor uses for CWV, so a
// 'POOR' reads the same way across every PSI-derived check in this app.
const AUDIT_FAIL_SCORE = 0.9;

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
      recommendedAction: { label: 'Fix viewport meta tag', generatorId: 'viewport', params: {}, effort: effortForGenerator('viewport') },
      expectedImpact: { label: missingViewport.length === reachable.length ? 'High' : 'Medium', basis: 'computed', value: sumImpressions(missingViewport) },
    }));
  }
  if (wrongViewport.length) {
    findings.push(makeFinding({
      id: 'mobile-usability:misconfigured-viewport',
      evidence: { affectedCount: wrongViewport.length, checkedCount: reachable.length, samplePages: wrongViewport.slice(0, 5).map((r) => ({ page: r.page, content: r.analysis.viewportContent })) },
      whyItMatters: `${wrongViewport.length} of ${reachable.length} checked pages have a viewport tag that doesn't include "width=device-width" — a fixed-width viewport still forces the desktop-scaled-down layout mobile browsers are supposed to avoid.`,
      priority: 'medium',
      recommendedAction: { label: 'Fix viewport meta tag', generatorId: 'viewport', params: {}, effort: effortForGenerator('viewport') },
      expectedImpact: { label: 'Medium', basis: 'computed', value: sumImpressions(wrongViewport) },
    }));
  }
  if (zoomBlocked.length) {
    findings.push(makeFinding({
      id: 'mobile-usability:zoom-blocked',
      evidence: { affectedCount: zoomBlocked.length, checkedCount: reachable.length, samplePages: zoomBlocked.slice(0, 5).map((r) => ({ page: r.page, content: r.analysis.viewportContent })) },
      whyItMatters: `${zoomBlocked.length} of ${reachable.length} checked pages block pinch-to-zoom (user-scalable=no or maximum-scale<=1) — a real accessibility and usability problem for low-vision users, not just a missed best practice.`,
      priority: 'high',
      recommendedAction: { label: 'Fix viewport meta tag', generatorId: 'viewport', params: {}, effort: effortForGenerator('viewport') },
      expectedImpact: { label: 'High', basis: 'computed', value: sumImpressions(zoomBlocked) },
    }));
  }

  // Real tap-target-sizing and legible-font-size audits, via PSI's
  // Lighthouse "seo" category — only when PAGESPEED_API_KEY is set (see
  // meta.dataSources above). Same all-at-once Promise.all fan-out as
  // technical-seo-analysis.js's own fetchCoreWebVitals batch — the
  // established pattern in this codebase for a per-page PSI call over a
  // rotation-sized batch (<= MAX_PAGES).
  //
  // Both audits are near-always a shared CSS/template issue, not something
  // a single-page content generator can safely rewrite blind — same reason
  // technical-seo.js's own CWV/layout-shift findings stay reportOnly. But
  // font-size-too-small is the exact same defect shape font-consistency.js
  // already auto-fixes (a one-element inline font-size override) whenever
  // Lighthouse's own per-element evidence shows that's the real cause —
  // reused here via the same 'font-size-override' fixType, never a new,
  // separately-invented fix path. tap-target-too-small has no equivalent
  // safe fix: Lighthouse doesn't say WHICH CSS property (width, height,
  // padding, or font-size affecting the line box) made the target too
  // small, so swapping one blind risks changing the wrong property on an
  // element/class other targets may also share — the same "no resolvable
  // single-element fix" caution font-consistency.js gives a shared class
  // with no confirmed convention, so it always stays informational.
  let smallTapTargets = [];
  let illegibleFontSize = [];
  if (pagespeedConfigured() && reachable.length) {
    const audited = await Promise.all(reachable.map(async (r) => ({
      ...r,
      audit: await fetchMobileUsabilityAudit(r.page).catch((err) => ({ ok: false, error: String(err.message || err) })),
    })));
    const auditedOk = audited.filter((r) => r.audit.ok);
    smallTapTargets = auditedOk.filter((r) => r.audit.tapTargets.score != null && r.audit.tapTargets.score < AUDIT_FAIL_SCORE);
    illegibleFontSize = auditedOk.filter((r) => r.audit.fontSize.score != null && r.audit.fontSize.score < AUDIT_FAIL_SCORE);

    const tapTargetsFinding = aggregateSystemicFinding({
      id: 'mobile-usability:small-tap-targets',
      affected: smallTapTargets,
      checkedCount: auditedOk.length,
      getPage: (r) => r.page,
      getImpressions: (r) => r.impressions,
      extraEvidence: (affected) => ({ sampleFailingElements: affected.slice(0, 5).map((r) => ({ page: r.page, elements: r.audit.tapTargets.failingElements })) }),
      whyItMatters: (n, c) => `${n} of ${c} checked pages have buttons or links too small/close together for a real thumb tap (Lighthouse's tap-target audit) — a real conversion and accessibility problem on mobile, not a cosmetic one.`,
      // Never a safe single-element fix — see the header comment above this
      // block for why (which CSS property caused it is genuinely ambiguous).
      recommendedAction: null,
      reportOnly: (representative) => ({
        kind: 'tap-target-too-small',
        label: 'Buttons or links are too small/close together for a mobile tap',
        page: representative.page,
        whyBlocked: 'Lighthouse\'s tap-target audit flagged this element as too small or too close to a neighboring target, but it doesn\'t say which CSS property (width, height, padding, or a shared button/link class) is the real cause — changing one blind could resize every other element sharing that class, or miss the actual cause entirely. Someone needs to pick the right property to adjust.',
      }),
    });
    if (tapTargetsFinding) findings.push(tapTargetsFinding);

    const fontSizeFinding = aggregateSystemicFinding({
      id: 'mobile-usability:illegible-font-size',
      affected: illegibleFontSize,
      checkedCount: auditedOk.length,
      getPage: (r) => r.page,
      getImpressions: (r) => r.impressions,
      extraEvidence: (affected) => ({ samples: affected.slice(0, 5).map((r) => ({ page: r.page, summary: r.audit.fontSize.summary })) }),
      whyItMatters: (n, c) => `${n} of ${c} checked pages have text below Lighthouse's legible-font-size threshold on mobile — real visitors on a phone have to pinch-zoom to read it.`,
      // Prefer a row whose real Lighthouse evidence pins the cause to one
      // element's own inline font-size override — the same safe, single-
      // element shape font-consistency.js already fixes via
      // content-integrity-repair's 'font-size-override' fixType. Falls back
      // to the highest-impression row (same default every other systemic
      // finding uses) only when no affected row has that evidence, so the
      // reportOnly row below still points somewhere real.
      pickRepresentative: (affected) => affected.find((r) => findSafeFontSizeOverrideElement(r))
        || [...affected].sort((a, b) => (b.impressions || 0) - (a.impressions || 0))[0],
      recommendedAction: (representative) => {
        const outerHtml = findSafeFontSizeOverrideElement(representative);
        if (!outerHtml) return null;
        return {
          label: 'Remove inline font-size override making this text illegible',
          generatorId: 'content-integrity-repair',
          params: { page: representative.page, fixType: 'font-size-override', outerHtml },
          effort: effortForGenerator('content-integrity-repair'),
        };
      },
      reportOnly: (representative) => ({
        kind: 'font-size-too-small',
        label: 'Text renders below the legible-size threshold on mobile',
        page: representative.page,
        whyBlocked: 'Lighthouse\'s font-size audit flagged this page\'s text as too small on mobile, but its real per-element evidence doesn\'t show a single element with its own inline font-size override — either the size comes from a shared CSS class/stylesheet rule (changing it blind could shrink or enlarge every other element sharing that class), or this audit returned no per-element detail to check. Someone needs to decide the right size.',
      }),
    });
    if (fontSizeFinding) findings.push(fontSizeFinding);
  }

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    checkedPages: batch, // this run's rotation batch — see security-headers.js facts for why
    pagesChecked: reachable.length,
    pagesMissingViewport: missingViewport.length,
    pagesWithWrongViewport: wrongViewport.length,
    pagesBlockingZoom: zoomBlocked.length,
    pagesWithSmallTapTargets: smallTapTargets.length,
    pagesWithIllegibleFontSize: illegibleFontSize.length,
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
