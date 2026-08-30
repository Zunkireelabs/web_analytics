import { getSiteById } from '../store/read.js';
import { sitePageUrl } from '../implementers/lib/design-drift.js';
import { makeFinding } from './lib/findings.js';
import { effortForGenerator } from './lib/page-content.js';
import { captureFontSamples } from './lib/font-consistency-capture.js';
import { findFontSizeOutliers, hasInlineFontSizeOverride } from './lib/font-consistency-analysis.js';
import { callLLM } from '../llm.js';

// Checks whether the SAME real role of element (an h1, an h2, body
// paragraph text) renders at the same real, computed font-size across a
// page-type-diverse sample of the site's own live pages — the "same place
// on the website" consistency check. Unlike every other content-integrity
// check, font-size is CSS-cascade-derived (a shared class, a stylesheet
// rule, a media query), not something a static HTML fetch can read
// reliably, so this reuses the Design Agent's real headless-browser
// plumbing (font-consistency-capture.js) instead of page-content.js's
// cheerio-based analyzePage. That's real cost (a live browser launch per
// run, not a cheap fetch), so this agent is throttled (see job.js's
// THROTTLED_AGENT_IDS), not run daily like the rest of content-integrity's
// checks.
//
// Only ONE outlier shape has a safe automatic fix: an element whose
// font-size differs because IT SPECIFICALLY carries an inline
// style="font-size:...} override (a one-element, exact-match-or-refuse
// patch — see generators/content-integrity-repair.js's 'font-size-override'
// fixType). An outlier caused by a different/wrong CSS class, or by the
// shared class's own stylesheet rule being wrong on one page, has no safe
// single-element fix — changing a shared class's rule affects every OTHER
// element using that class too, a much bigger blast radius than this app
// auto-applies unattended anywhere else. Those stay visible, manual-only.
export const meta = {
  id: 'font-consistency',
  name: 'Font Consistency Agent',
  description: 'Checks whether headings and body text render at the same real (computed) font-size across a sample of the site\'s own live pages, using a real headless-browser capture — flags genuine outliers and auto-fixes the ones caused by a one-element inline font-size override.',
  category: 'content',
  version: 1,
  dataSources: [
    { id: 'live-browser-capture', status: 'connected', description: 'Playwright headless capture of the site\'s own real rendered pages (window.getComputedStyle) — same plumbing as the Design Agent\'s live-site capture.' },
  ],
};

export async function run({ siteId, capture = captureFontSamples, fetchSite = getSiteById }) {
  const site = await fetchSite(siteId);
  const homepageUrl = sitePageUrl(site);
  if (!homepageUrl) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No website_domain/gsc_property configured for this site — nothing to capture.',
      generatedAt: new Date().toISOString(),
    };
  }

  let pages;
  try {
    pages = await capture(homepageUrl);
  } catch (err) {
    return {
      meta, status: 'error', facts: null, narrative: null,
      message: `Live capture failed: ${err.message}`,
      generatedAt: new Date().toISOString(),
    };
  }
  if (!pages?.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'Could not capture any real pages for this site (all navigations failed).',
      generatedAt: new Date().toISOString(),
    };
  }

  const outliers = findFontSizeOutliers(pages);
  const safeOutlier = outliers.find((o) => hasInlineFontSizeOverride(o.sample.outerHtml));

  const finding = outliers.length ? makeFinding({
    id: 'font-consistency:size-outlier',
    evidence: {
      affectedCount: outliers.length,
      checkedPages: pages.length,
      samples: outliers.slice(0, 5).map((o) => ({ group: o.group, page: o.url, expected: o.expectedFontSize, actual: o.actualFontSize })),
    },
    whyItMatters: `${outliers.length} element(s) (heading or body text) render at a different real font-size than the same element type on the rest of this site's checked pages — a visitor moving between pages sees inconsistent typography.`,
    priority: outliers.length >= 3 ? 'high' : 'medium',
    recommendedAction: safeOutlier ? {
      label: 'Remove inline font-size override',
      generatorId: 'content-integrity-repair',
      params: { page: safeOutlier.url, fixType: 'font-size-override', outerHtml: safeOutlier.sample.outerHtml },
      effort: effortForGenerator('content-integrity-repair'),
    } : null,
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
