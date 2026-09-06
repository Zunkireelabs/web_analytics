import { priorPeriod, daysAgoInTz } from '../../util/dates.js';
import { getQueryPageMetrics } from '../../store/read.js';
import { buildPageMetrics } from './growth-scoring.js';

// Finds the pages that are LOSING ground, so the shipping loop can fix them
// this week instead of discovering the damage in next month's report.
//
// The gap this closes: growth-scoring.js's demandScore reads a page's
// impressions as a LEVEL and rewards a high one. A page that collapsed from
// 2,000 impressions to 400 therefore scores lower than a flat page sitting at
// 1,000 — the ranker actively deprioritised exactly the pages that were
// bleeding. Worse, a page whose traffic had already gone to near-zero picked
// up demandScore's -500 "no measured search demand" penalty, so the further a
// page fell the more certainly it was ignored. Drops were detected elsewhere
// (notifications/detect.js catches a health-score and an AI-citation-rate
// drop) but only ever became an email; nothing routed "this page is losing
// impressions" into the work queue.
//
// LEADING INDICATORS, not just damage reports. Rankings slip first,
// impressions follow, clicks follow last — so acting on a position slide is
// what prevents next week's impression loss, which is the whole point. The
// three signals below are ordered by how early they fire.
//
// Every number here is computed from this site's own real GSC rows. Nothing
// is modelled, forecast, or asked of an LLM — same house convention as
// opportunity.js's estimatedTrafficGain and growth-projection.js.

// Google backfills GSC for about three days, so this is the freshest date
// that is actually final. Same value and same reason as job.js's own
// GSC_LAG_DAYS; duplicated rather than imported because job.js imports this
// module's caller and reaching back into it would close a cycle.
const GSC_LAG_DAYS = 3;

// A page must have had real volume BEFORE it fell for its decline to mean
// anything. Without this floor a page going 5 -> 2 impressions reads as a
// -60% emergency and would outrank a page that genuinely lost 800.
export const MIN_BASELINE_IMPRESSIONS = 100;

// Average position worsening by this many places. The earliest signal
// available in GSC data: the ranking moves before the impressions do.
export const POSITION_EROSION_PLACES = 1.5;

// Impressions already falling by this share, net of the site-wide move.
export const IMPRESSION_DROP_PCT = 0.25;

// Clicks falling this much faster than impressions, i.e. the page still
// appears but stopped being chosen — a title/description or SERP-feature
// problem rather than a ranking one.
export const CTR_DECAY_PCT = 0.30;

/**
 * Compares two page-metric maps (the shape buildPageMetrics returns).
 *
 * SITE-WIDE MOVES ARE SUBTRACTED, not special-cased. Every page's change is
 * measured RELATIVE to how the whole site moved, so a Google update or a
 * seasonal lull that pulls everything down 30% does not mark all 94 pages as
 * individually declining and trigger a mass-ship of 80 PRs at a cause no page
 * edit can address. A page is only "declining" here if it fell materially
 * more than the site did. This is why there is no separate "is it an
 * algorithm update?" switch to get wrong — the arithmetic already handles it.
 *
 * @returns { declines: Map<page, {...}>, siteWide: {...} }
 */
export function detectDeclines(currentMetrics, priorMetrics) {
  const siteWide = siteWideChange(currentMetrics, priorMetrics);
  const declines = new Map();

  for (const [page, prior] of priorMetrics) {
    if (prior.impressions < MIN_BASELINE_IMPRESSIONS) continue;
    // A page that vanished entirely still counts — absence is the most
    // severe decline there is, and treating a missing row as "no data, skip"
    // would silently hide the worst cases.
    const current = currentMetrics.get(page) || { impressions: 0, clicks: 0, ctr: 0, avgPosition: null };

    const reasons = [];
    let impressionsLost = 0;
    let impressionsAtRisk = 0;

    // Signal 1 — POSITION EROSION (earliest). Only meaningful when both
    // periods actually have a position; a null means the page had no ranking
    // data, not that it ranked at 0.
    if (prior.avgPosition != null && current.avgPosition != null) {
      const slipped = current.avgPosition - prior.avgPosition; // higher number = worse rank
      if (slipped >= POSITION_EROSION_PLACES) {
        reasons.push(`position ${prior.avgPosition} -> ${current.avgPosition} (slipped ${slipped.toFixed(1)} places)`);
        // Exposure, not a forecast: the impressions this page still earns are
        // what a continued slide puts at risk. Labelled as such by the caller.
        impressionsAtRisk += current.impressions;
      }
    }

    // Signal 2 — IMPRESSIONS ALREADY FALLING, net of the site-wide move.
    //
    // The baseline EXCLUDES this page (leave-one-out). Measuring a page
    // against a site total that includes itself cancels the signal exactly
    // when it matters most: on a small site, or wherever one page carries
    // most of the traffic, that page IS the site, so its own collapse moves
    // the baseline with it and it reads as "in line with the site". A
    // single-page site collapsing 2,000 -> 400 produced no finding at all
    // before this. With the page held out, the comparison asks the question
    // that was always intended — did this page fall faster than everything
    // ELSE? — and a site with no other pages correctly falls back to the
    // page's own absolute change.
    const priorOthers = siteWide.priorImpressions - prior.impressions;
    const currentOthers = siteWide.currentImpressions - current.impressions;
    const baselineChangePct = priorOthers > 0 ? (currentOthers - priorOthers) / priorOthers : 0;
    const expected = prior.impressions * (1 + baselineChangePct);
    const shortfall = expected - current.impressions;
    const relativeDropPct = expected > 0 ? shortfall / expected : 0;
    if (relativeDropPct >= IMPRESSION_DROP_PCT) {
      const pct = Math.round(relativeDropPct * 100);
      reasons.push(
        `impressions ${prior.impressions} -> ${current.impressions} (${pct}% below where the site-wide trend puts it)`
      );
      impressionsLost += Math.round(shortfall);
    }

    // Signal 3 — CTR DECAY at held rank: still shown, no longer clicked.
    if (prior.ctr > 0 && current.impressions > 0) {
      const ctrDropPct = (prior.ctr - current.ctr) / prior.ctr;
      if (ctrDropPct >= CTR_DECAY_PCT) {
        reasons.push(
          `CTR ${(prior.ctr * 100).toFixed(1)}% -> ${(current.ctr * 100).toFixed(1)}% (${Math.round(ctrDropPct * 100)}% decay)`
        );
        // Clicks forgone at today's impression level — again measured, not modelled.
        impressionsAtRisk += Math.round(current.impressions * ctrDropPct);
      }
    }

    if (!reasons.length) continue;

    declines.set(page, {
      page,
      reasons,
      impressionsLost,
      impressionsAtRisk,
      priorImpressions: prior.impressions,
      currentImpressions: current.impressions,
      // What the ranker sorts on. Realised loss counts for more than exposure
      // because it already happened, but exposure still counts — acting on it
      // is the only way to stop it becoming realised loss next week.
      declineScore: impressionsLost + Math.round(impressionsAtRisk * 0.5),
    });
  }

  return { declines, siteWide };
}

// The whole site's period-over-period move, used as the baseline every page
// is measured against.
function siteWideChange(currentMetrics, priorMetrics) {
  const sum = (m, field) => [...m.values()].reduce((s, v) => s + (v[field] || 0), 0);
  const priorImpressions = sum(priorMetrics, 'impressions');
  const currentImpressions = sum(currentMetrics, 'impressions');
  const impressionsChangePct = priorImpressions > 0
    ? (currentImpressions - priorImpressions) / priorImpressions
    : 0;
  return {
    priorImpressions,
    currentImpressions,
    impressionsChangePct,
    // Reported so a human (and notifications/detect.js) can tell "the site is
    // down" from "these pages are down", which call for different responses.
    siteIsDown: impressionsChangePct <= -IMPRESSION_DROP_PCT,
  };
}

/**
 * Loads both periods and runs the comparison. `end` defaults to today; the
 * window is `windowDays` long and is compared against the immediately
 * preceding window of equal length via priorPeriod().
 *
 * Failure is never fatal to the caller: the shipping loop must still run a
 * normal day if GSC is unavailable, exactly as it already does for its own
 * metrics fetch.
 */
export async function loadDeclines(siteId, { timezone = 'UTC', windowDays = 7, now = new Date() } = {}) {
  // The window MUST end at the freshest fully-final GSC date, never today.
  // Google backfills for ~3 days (job.js's GSC_LAG_DAYS, the same constant the
  // daily report already uses), so a window ending today carries 3 days of
  // partial data. That makes the current period look smaller than the prior
  // one for EVERY page, and the detector would report a site-wide collapse
  // every single day — measured live on site 1, a window ending today showed
  // "-43.8% site-wide" that was almost entirely missing data, not lost
  // traffic. Comparing two equal-length windows that are both complete is the
  // only way the comparison means anything.
  const endDate = daysAgoInTz(timezone, GSC_LAG_DAYS, now);
  const startDate = daysAgoInTz(timezone, GSC_LAG_DAYS + windowDays - 1, now);
  const prior = priorPeriod(startDate, endDate);

  const [currentRows, priorRows] = await Promise.all([
    getQueryPageMetrics(siteId, startDate, endDate, { minImpressions: 1 }),
    getQueryPageMetrics(siteId, prior.start, prior.end, { minImpressions: 1 }),
  ]);

  const result = detectDeclines(buildPageMetrics(currentRows), buildPageMetrics(priorRows));
  return { ...result, period: { start: startDate, end: endDate, prior } };
}
