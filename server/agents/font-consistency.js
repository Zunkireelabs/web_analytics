import { getSiteById } from '../store/read.js';
import { sitePageUrl } from '../implementers/lib/design-drift.js';
import { makeFinding } from './lib/findings.js';
import { effortForGenerator } from './lib/page-content.js';
import { captureFontSamples } from './lib/font-consistency-capture.js';
import { findFontSizeOutliers, hasInlineFontSizeOverride } from './lib/font-consistency-analysis.js';
import { callLLM } from '../llm.js';
import { checkBrowserAvailable } from './lib/browser-preflight.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';

// Checks whether the SAME real role of element (an h1, an h2, body
// paragraph text) renders at the same real, computed font-size across a
// page-type-diverse sample of the site's own live pages — the "same place
// on the website" consistency check. Unlike every other content-integrity
// check, font-size is CSS-cascade-derived (a shared class, a stylesheet
// rule, a media query), not something a static HTML fetch can read
// reliably, so this reuses the Design Agent's real headless-browser
// plumbing (font-consistency-capture.js) instead of page-content.js's
// cheerio-based analyzePage. That's real cost (a live browser launch per
// run, not a cheap fetch) — bounded by this agent's own page sample size,
// not by starving it of runs. It ran monthly until 2026-09-03 and that
// throttle is gone (see job.js's THROTTLED_AGENT_IDS for why): typography
// regressions ship in a single deploy, and a monthly agent that fails looks
// exactly like a monthly agent that isn't due.
//
// Outliers are checked against their OWN page-type/template's real majority
// first, falling back to the sitewide majority only when that template has
// too few sampled pages of its own to have an opinion (see
// findFontSizeOutliers) — so a site that legitimately runs a bigger heading
// on its landing-style templates than on interior pages never gets flagged
// for that, on any site, without any per-tenant configuration.
//
// Two outlier shapes have a safe automatic fix:
//   - an element whose font-size differs because IT SPECIFICALLY carries an
//     inline style="font-size:...} override (a one-element, exact-match-or-
//     refuse patch — generators/content-integrity-repair.js's
//     'font-size-override' fixType);
//   - an element whose classes differ from the resolved bucket's own real,
//     already-observed convention (findFontSizeOutliers' `siteConvention`) —
//     routed through the same 'typography-drift' fixType design-consistency.js
//     already uses: an exact-match-or-refuse class swap against a value this
//     SAME site was seen using elsewhere, never invented and never borrowed
//     from another tenant.
// Anything else — the shared class's own stylesheet rule differing on just
// one page, or a bucket with no resolvable convention — has no safe single-
// element fix (changing a shared class's rule affects every OTHER element
// using it too) and stays visible, manual-only.
export const meta = {
  id: 'font-consistency',
  name: 'Font Consistency Agent',
  description: 'Checks whether headings and body text render at the same real (computed) font-size across a sample of the site\'s own live pages, comparing each page-type/template against its own real majority first — flags genuine outliers and auto-fixes the ones caused by a one-element inline font-size override or a resolvable CSS-class drift.',
  category: 'content',
  version: 1,
  dataSources: [
    { id: 'live-browser-capture', status: 'connected', description: 'Playwright headless capture of the site\'s own real rendered pages (window.getComputedStyle) — same plumbing as the Design Agent\'s live-site capture.' },
  ],
};

// Kept at the same size as the discovered baseline, not larger — the
// baseline has to stay the majority for "expected font-size" to mean
// anything (see font-consistency-capture.js).
const ROTATION_BATCH_SIZE = 8;

export async function run({
  siteId, start, end, capture = captureFontSamples, fetchSite = getSiteById,
  checkBrowser = checkBrowserAvailable, selectCandidates = selectCandidatePages,
  markChecked = markPagesChecked,
}) {
  const site = await fetchSite(siteId);
  const homepageUrl = sitePageUrl(site);
  if (!homepageUrl) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No website_domain/gsc_property configured for this site — nothing to capture.',
      generatedAt: new Date().toISOString(),
    };
  }

  // "The browser isn't installed here" and "the browser ran and every
  // navigation failed" are different problems with different owners, and
  // until 2026-09-03 both surfaced as the same redacted error. See
  // lib/browser-preflight.js.
  const browserCheck = await checkBrowser();
  if (!browserCheck.ok) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: browserCheck.reason,
      generatedAt: new Date().toISOString(),
    };
  }

  // Rotation slice, added to capture's own stable discovered baseline — see
  // font-consistency-capture.js's extraUrls comment for why the two are kept
  // distinct rather than merged. A rotation failure must not cost the run its
  // baseline check: the discovered pages are still capturable without it,
  // which is exactly how this agent behaved before rotation existed.
  const { batch } = await selectCandidates(siteId, meta.id, { start, end, batchSize: ROTATION_BATCH_SIZE })
    .catch((err) => {
      console.warn(`[font-consistency] rotation selection failed for site ${siteId}, falling back to the discovered baseline only: ${err.message}`);
      return { batch: [] };
    });

  // Deliberately not caught here — a live-capture failure (navigation
  // timeout, a context that dies mid-run) propagates to runner.js's own
  // try/catch, which already routes it through safeMessage before
  // persisting/emitting anything customer-facing. Catching it here to build a
  // custom error string would mean interpolating err.message directly into
  // customer-facing text, the exact raw-exception-leak pattern
  // server/lib/errors.js exists to prevent (see its own header comment).
  // Browser-launch failure specifically is handled by the preflight above,
  // which is a diagnosable state rather than an exception.
  const pages = await capture(homepageUrl, { extraUrls: batch });
  if (!pages?.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'Could not capture any real pages for this site (all navigations failed).',
      generatedAt: new Date().toISOString(),
    };
  }

  // Advance the rotation only for pages this run genuinely captured. Marking
  // the whole selected batch would let a page that failed to navigate count
  // as checked and drop to the back of the queue for another full cycle —
  // the page most likely to be broken becoming the one least likely to be
  // looked at again.
  const capturedUrls = new Set(pages.map((p) => p.url));
  const rotationChecked = batch.filter((u) => capturedUrls.has(u));
  if (rotationChecked.length) {
    await markChecked(siteId, meta.id, rotationChecked).catch((err) => {
      console.error(`[font-consistency] could not advance rotation for site ${siteId}:`, err.message);
    });
  }

  const outliers = findFontSizeOutliers(pages);
  const safeOutlier = outliers.find((o) => hasInlineFontSizeOverride(o.sample.outerHtml));
  // A class-driven outlier is only auto-fixable when findFontSizeOutliers
  // could resolve a real, already-observed convention for its own bucket
  // (see that file's siteConvention field) — this site's own evidence,
  // never a value carried over from another tenant or another finding.
  const classOutlier = !safeOutlier ? outliers.find((o) => o.siteConvention) : null;
  // The element carries no class of its own (styled purely via an ancestor
  // wrapper + tag selector, e.g. Chayce's ".hiw-hero h1") but this run's own
  // evidence already confirmed that wrapper class is unique to this one page
  // AND its real declared value is a plain length — see
  // findFontSizeOutliers' scopedSelector field.
  const scopedOutlier = !safeOutlier && !classOutlier ? outliers.find((o) => o.scopedSelector) : null;
  const fixableOutlier = safeOutlier || classOutlier || scopedOutlier;
  // A page-scoped ancestor selector was confirmed safe to target, but its
  // real declared value is a fluid/responsive expression (clamp()/vw/calc())
  // — genuinely unfixable without inventing new responsive bounds, not the
  // generic "shared CSS" reason every other unresolvable case gets.
  const fluidOutlier = !fixableOutlier ? outliers.find((o) => o.scopedButFluid) : null;

  const finding = outliers.length ? makeFinding({
    id: 'font-consistency:size-outlier',
    evidence: {
      affectedCount: outliers.length,
      checkedPages: pages.length,
      samples: outliers.slice(0, 5).map((o) => ({ group: o.group, pageType: o.pageType, page: o.url, expected: o.expectedFontSize, actual: o.actualFontSize })),
    },
    whyItMatters: `${outliers.length} element(s) (heading or body text) render at a different real font-size than the same element type on the rest of this site's checked pages — a visitor moving between pages sees inconsistent typography.`,
    priority: outliers.length >= 3 ? 'high' : 'medium',
    recommendedAction: safeOutlier ? {
      label: 'Remove inline font-size override',
      generatorId: 'content-integrity-repair',
      params: { page: safeOutlier.url, fixType: 'font-size-override', outerHtml: safeOutlier.sample.outerHtml },
      effort: effortForGenerator('content-integrity-repair'),
    } : classOutlier ? {
      label: 'Match this element\'s size to this site\'s own template convention',
      generatorId: 'content-integrity-repair',
      params: {
        page: classOutlier.url,
        fixType: 'typography-drift',
        sectionClasses: classOutlier.sample.classes,
        siteConvention: classOutlier.siteConvention,
        outerHtml: classOutlier.sample.outerHtml,
        textRole: classOutlier.group === 'p' ? 'body' : 'heading',
      },
      effort: effortForGenerator('content-integrity-repair'),
    } : scopedOutlier ? {
      label: 'Correct this page-specific heading style to this site\'s own real convention',
      generatorId: 'content-integrity-repair',
      params: {
        page: scopedOutlier.url,
        fixType: 'typography-drift-scoped',
        ancestorClass: scopedOutlier.scopedSelector.ancestorClass,
        tag: scopedOutlier.scopedSelector.tag,
        expectedFontSize: scopedOutlier.expectedFontSize,
      },
      effort: effortForGenerator('content-integrity-repair'),
    } : null,
    // No safe automatic fix, but a real, measured defect — so it goes to the
    // Action Center as a read-only row rather than being dropped, which is
    // what happened to every one of these until 2026-09-03 (see this file's
    // header: "Those stay visible, manual-only" was the intent all along,
    // and buildRecommendations' `if (!action?.generatorId) continue` was
    // quietly discarding them).
    //
    // `page` is the worst outlier's own page, not a sitewide '': it gives the
    // row somewhere real to point, and it is the page a human should open
    // first. The dedup key is (page, kind), so a second genuinely different
    // page's outlier gets its own row instead of overwriting this one.
    reportOnly: fixableOutlier ? null : {
      kind: 'font-size-inconsistency',
      label: 'Text renders at an inconsistent size',
      page: fluidOutlier ? fluidOutlier.url : outliers[0].url,
      whyBlocked: fluidOutlier
        ? `This page's own heading style is confirmed scoped to only this one page (no other page uses "${fluidOutlier.scopedSelector?.ancestorClass || fluidOutlier.sample.ancestorClass}"), so a fix here can't affect any other element — but its real font-size is a responsive expression ("${fluidOutlier.scopedButFluid}"), not a plain size. Correcting it would mean inventing new responsive bounds that haven't been observed anywhere on this site, so someone needs to pick the right fluid value.`
        : 'This font-size comes from a shared CSS class with no resolvable single-element replacement (either this template has too few sampled pages of its own to have a confirmed convention, or the class is already correct and a stylesheet rule is the real cause) — changing it blind could move every other element on the site that shares the class. Someone needs to decide which size is the correct one.',
    },
    expectedImpact: { label: outliers.length >= 3 ? 'High' : 'Medium', basis: 'computed', value: outliers.length },
  }) : null;

  const findings = finding ? [finding] : [];
  const facts = { checkedPages: pages.map((p) => p.url), findings };

  const system = 'You are a design consistency specialist writing for a non-technical site owner. Given real, ' +
    'computed font-size measurements captured from this site\'s own live pages, write 2-3 sentences naming the ' +
    'single most important real inconsistency and one concrete next step. Use ONLY the data given, never invent ' +
    'a page, element, or number not present in the facts. Plain text, no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
      .catch((err) => { console.warn('[agents] font-consistency narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
