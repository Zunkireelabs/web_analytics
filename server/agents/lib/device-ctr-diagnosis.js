// Turns device-intelligence.js's "this device's CTR is below the site's own
// average" finding from a permanent, undiagnosed reportOnly into an
// evidence-gated diagnosis — reusing capabilities that already exist
// elsewhere in this platform rather than inventing a new detection system:
//   - ranking position: device-intelligence.js already fetches this per
//     device from gsc_breakdown; no new data needed.
//   - title length: the exact MIN_TITLE_LEN/MAX_TITLE_LEN bar
//     page-content.js's own contentGapChecks() already uses.
//   - viewport meta: the exact hasViewportMeta/viewportHasDeviceWidth
//     fields analyzePageUrl() already computes, and the exact 'viewport'
//     generator mobile-usability.js already recommends from them.
// The one genuinely missing piece was per-(page, device) GSC data to know
// WHICH pages sit behind a device's aggregate number — store/read.js's new
// getPagePerformanceByDevice() closes that gap from data already ingested
// (gsc_query_page has always had a device column; nothing selected it
// grouped by page before now).
//
// Never invents a cause: a device's CTR deficit either clears one of these
// two real, evidence-backed explanations, or it stays undiagnosed and says
// so honestly (which checks ran and came back clean), rather than a vague
// "look at it."
import { analyzePageUrl, MIN_TITLE_LEN, MAX_TITLE_LEN } from './page-content.js';
import { getPagePerformanceByDevice, getQueriesForPage } from '../../store/read.js';
import { effortFromDifficulty } from './findings.js';

const TOP_PAGES_TO_INSPECT = 8;

// GSC's own well-established CTR-by-position curve drops steeply over the
// first handful of positions — a real ~1.5-position gap between devices is
// already sufficient on its own to explain a lower CTR, with nothing on
// this platform able to move a ranking position directly (it's an outcome
// of the site's whole authority/relevance/content picture, not one file).
const MEANINGFUL_POSITION_GAP = 1.5;

// A real minimum share of the inspected top-impression pages, not "found
// one." One bad title among eight top pages is that ONE page's own
// title-length problem (already caught by the ordinary per-page content-gap
// check) — not evidence this DEVICE's aggregate CTR is being dragged down
// by it specifically.
const MIN_AFFECTED_SHARE = 0.5;

/**
 * @param {number} siteId
 * @param {{device:string, ctr:number, impressions:number, avgPosition:?number}} deviceRow the flagged low-CTR device row (device-intelligence.js's own flagLowCtr output)
 * @param {Array<{device:string, avgPosition:?number}>} allDeviceRows every device row from the same run, for the position comparison
 * @param {{start:string,end:string, fetchPage?:Function, getPagePerformance?:Function}} opts
 * @returns {{cause:string, evidence:object, explanation:?string, fixes: Array<{scope:'sitewide'|'page', page?:string, recommendedAction:object}>}}
 */
export async function diagnoseDeviceCtrDeficit(siteId, deviceRow, allDeviceRows, {
  start, end, fetchPage = analyzePageUrl, getPagePerformance = getPagePerformanceByDevice,
  getTopQuery = getQueriesForPage,
} = {}) {
  const device = deviceRow.device;

  // 1. Ranking position — cheapest check, no live fetch, and if it clears
  // the bar it's sufficient evidence on its own. Compared against the BEST
  // other device's position (not an average): the real question is whether
  // even the strongest comparison point still shows a gap.
  const others = allDeviceRows.filter((d) => d.device !== device && d.avgPosition != null);
  if (deviceRow.avgPosition != null && others.length) {
    const bestOtherPosition = Math.min(...others.map((d) => d.avgPosition));
    const gap = deviceRow.avgPosition - bestOtherPosition;
    if (gap >= MEANINGFUL_POSITION_GAP) {
      return {
        cause: 'position',
        evidence: { device, position: deviceRow.avgPosition, bestOtherPosition, gap: Math.round(gap * 100) / 100 },
        explanation: `${device} ranks ${gap.toFixed(1)} position(s) worse on average than this site's best-performing device (${bestOtherPosition}) — a lower ranking position is a well-established, direct cause of lower click-through rate by itself. Improving ${device}'s ranking position is a broader SEO effort, not a single fixable file.`,
        fixes: [],
      };
    }
  }

  // 2. Title-truncation and viewport-meta both describe how a listing
  // renders specifically in Google's MOBILE results — neither is a real
  // explanation for a desktop or tablet gap, so this never claims one.
  if (device !== 'MOBILE') {
    return {
      cause: 'undiagnosed',
      evidence: { device, position: deviceRow.avgPosition, checkedPosition: true, checkedTitleLength: false, checkedViewport: false },
      explanation: null,
      fixes: [],
    };
  }

  const topPages = await getPagePerformance(siteId, start, end, device, TOP_PAGES_TO_INSPECT);
  if (!topPages.length) {
    return {
      cause: 'undiagnosed',
      evidence: { device, position: deviceRow.avgPosition, checkedPosition: true, checkedTitleLength: false, checkedViewport: false, inspectedPages: 0 },
      explanation: null,
      fixes: [],
    };
  }

  const fetched = await Promise.all(topPages.map(async (p) => ({ ...p, result: await fetchPage(p.page).catch(() => null) })));
  const reachable = fetched.filter((f) => f.result?.ok);
  if (!reachable.length) {
    return {
      cause: 'undiagnosed',
      evidence: { device, position: deviceRow.avgPosition, checkedPosition: true, inspectedPages: topPages.length, reachablePages: 0 },
      explanation: null,
      fixes: [],
    };
  }

  const titleTooLong = reachable.filter((f) => (f.result.analysis.title?.length || 0) > MAX_TITLE_LEN);
  const viewportBroken = reachable.filter((f) => !f.result.analysis.hasViewportMeta || !f.result.analysis.viewportHasDeviceWidth);
  const titleShare = titleTooLong.length / reachable.length;
  const viewportShare = viewportBroken.length / reachable.length;

  // Viewport checked first: a broken/missing tag is one sitewide template
  // fix (mobile-usability.js's own 'viewport' generator/params shape,
  // reused verbatim so this can never diverge into a second, competing
  // viewport-fix path) and the more fundamental mobile-rendering problem —
  // worth fixing even alongside a real title-length finding, not instead of it.
  if (viewportShare >= MIN_AFFECTED_SHARE) {
    return {
      cause: 'viewport',
      evidence: { device, inspectedPages: reachable.length, affectedPages: viewportBroken.map((f) => f.page), viewportSharePct: Math.round(viewportShare * 100) },
      explanation: `${viewportBroken.length} of ${reachable.length} top-impression MOBILE pages have a missing or misconfigured viewport meta tag — Google's mobile page-experience signal reads this as not mobile-friendly, which suppresses mobile CTR independent of ranking position.`,
      fixes: [{ scope: 'sitewide', recommendedAction: { label: 'Fix viewport meta tag', generatorId: 'viewport', params: {}, effort: effortFromDifficulty(1) } }],
    };
  }

  if (titleShare >= MIN_AFFECTED_SHARE) {
    // Real per-page top query — same primitive technical-seo.js's own
    // duplicate-title meta-title recommendation grounds itself with
    // (getQueriesForPage(..., 1)), since the generator requires a real
    // `query` param and refuses to fabricate one.
    const queryRows = await Promise.all(titleTooLong.map((f) => getTopQuery(siteId, start, end, f.page, 1)));
    return {
      cause: 'title-length',
      evidence: { device, inspectedPages: reachable.length, affectedPages: titleTooLong.map((f) => ({ page: f.page, titleLength: f.result.analysis.title.length })), titleSharePct: Math.round(titleShare * 100) },
      explanation: `${titleTooLong.length} of ${reachable.length} top-impression MOBILE pages have a title over ${MAX_TITLE_LEN} characters — mobile search results truncate titles more aggressively than desktop, which can cut off the part of the title that would have earned the click.`,
      fixes: titleTooLong.map((f, i) => ({
        scope: 'page',
        page: f.page,
        recommendedAction: { label: `Shorten title (${f.result.analysis.title.length} chars, over ${MAX_TITLE_LEN})`, generatorId: 'meta-title', params: { page: f.page, query: queryRows[i][0]?.query || '' }, effort: effortFromDifficulty(1) },
      })),
    };
  }

  return {
    cause: 'undiagnosed',
    evidence: {
      device, inspectedPages: reachable.length, checkedPosition: true, checkedTitleLength: true, checkedViewport: true,
      titleSharePct: Math.round(titleShare * 100), viewportSharePct: Math.round(viewportShare * 100),
    },
    explanation: null,
    fixes: [],
  };
}

export { MIN_AFFECTED_SHARE, MEANINGFUL_POSITION_GAP, TOP_PAGES_TO_INSPECT, MAX_TITLE_LEN };
