import { resolveMarketServiceTerms } from './market-seed-terms.js';
import { discoverMarketCompetitors } from './competitor-market-discovery.js';
import { collectCompetitorFootprints } from './competitor-footprint-collector.js';
import { buildOpportunities } from './competitor-opportunities.js';
import { upsertCompetitorClassification, listCompetitorsByKind } from '../../store/competitor-profiles.js';
import { getAllLatestFootprints } from '../../store/competitor-footprint.js';
import { saveCompetitorOpportunities, getLearnedMultipliers } from '../../store/competitor-opportunities.js';
import { getKeywordGaps } from '../../store/data-analyst.js';
import { getQueryPageMetrics } from '../../store/read.js';
import { resolveSiteLocations, LOCATION_NAMES } from './site-locations.js';
import { placeNames } from './local-seo.js';

// One project's competitor growth cycle: discover the market, collect rivals' footprints, turn them into scored
// opportunities in the EXISTING keyword_gaps queue.
//
// Where it stops is the point: it puts opportunities in the queue and nothing more. The weekly ship cycle
// (qualifyAndShipContentGaps) still decides what qualifies, the recommendation gates and autonomy rules still decide
// what ships, and a human still merges the PR. This module creates no draft, no PR and no second decision path.
//
// It is also the only place that decides whether a step should run at all: discovery is monthly, footprints have
// their own freshness window, and opportunity building is free, so it runs whenever there is a footprint to read.

const DISCOVERY_INTERVAL_DAYS = 30;
const OWN_QUERY_WINDOW_DAYS = 90;

/**
 * Run the cycle for one project.
 *
 * Returns a per-stage report: every stage says whether it ran, what it produced, and if it did not run, why. A stage
 * that was skipped is never reported as a stage that found nothing.
 */
export async function runCompetitorGrowthCycle(site, {
  discoveryIntervalDays = DISCOVERY_INTERVAL_DAYS,
  maxCompetitors = 5,
  maxOpportunities = 25,
  save = true,
  deps = {},
} = {}) {
  const d = {
    resolveMarketServiceTerms, discoverMarketCompetitors, collectCompetitorFootprints,
    upsertCompetitorClassification, listCompetitorsByKind, getAllLatestFootprints,
    saveCompetitorOpportunities, getLearnedMultipliers, getKeywordGaps, getQueryPageMetrics,
    ...deps,
  };
  const report = { siteId: site.id, learning: null, discovery: null, footprint: null, opportunities: null, costUsd: 0 };

  // Stage 0: what already happened. Done FIRST and free, so this run scores with what the project has actually
  // learned rather than with last run's picture — and so a verified outcome is counted once, close to when it was
  // measured. A failure here must not stop the paid stages, so it is reported and the run continues.
  if (save) {
    try {
      const learn = deps.learnFromCompetitorOutcomes || (await import('./competitor-outcome-learning.js')).learnFromCompetitorOutcomes;
      const learned = await learn(site.id);
      report.learning = {
        ran: true, lifecycleAdvanced: learned.advanced, outcomesCounted: learned.counted,
        skipped: learned.skipped, multipliers: learned.multipliers,
      };
    } catch (err) {
      report.learning = { ran: false, reason: 'failed', detail: err.message };
    }
  } else {
    report.learning = { ran: false, reason: 'dry_run' };
  }

  const services = await d.resolveMarketServiceTerms(site.id);
  report.serviceTerms = { count: services.terms.length, source: services.source };
  if (!services.terms.length) {
    report.discovery = { ran: false, reason: 'no_services_known' };
    report.footprint = { ran: false, reason: 'no_services_known' };
    report.opportunities = { ran: false, reason: 'no_services_known' };
    return report;
  }

  // --- Stage 1: discovery (paid, monthly) -----------------------------------
  const known = await d.listCompetitorsByKind(site.id, 'business', { limit: 50 });
  const needsDiscovery = !known.length || isStale(known, discoveryIntervalDays);
  if (!needsDiscovery) {
    report.discovery = { ran: false, reason: 'fresh', businessCompetitors: known.length };
  } else {
    const found = await d.discoverMarketCompetitors(site, { services: services.terms, maxBusiness: maxCompetitors });
    report.costUsd += found.costUsd || 0;
    if (!found.ok) {
      report.discovery = { ran: true, ok: false, reason: found.skipped, costUsd: found.costUsd || 0 };
    } else {
      let stored = 0;
      if (save) {
        const runAt = new Date();
        const all = [
          ...found.classified.business, ...found.classified.overflowBusiness,
          ...found.classified.organic, ...found.classified.keywordSpecific, ...found.classified.excluded,
        ];
        for (const c of all) {
          await d.upsertCompetitorClassification(site.id, c.domain, {
            kind: c.kind, relevanceScore: c.relevanceScore, excludedReason: c.excludedReason, runAt,
            classification: { ...c.evidence, reason: c.reason, confidence: c.confidence },
          });
          stored += 1;
        }
      }
      report.discovery = {
        ran: true, ok: true, stored,
        business: found.classified.business.map((c) => c.domain),
        organic: found.classified.organic.length,
        keywordSpecific: found.classified.keywordSpecific.length,
        excluded: found.classified.excluded.length,
        costUsd: found.costUsd || 0,
      };
    }
  }

  // --- Stage 2: footprints (paid, own freshness window) ---------------------
  if (!save) {
    // A dry run must never buy a footprint: the call is the expensive part, not the storing.
    report.footprint = { ran: false, reason: 'dry_run' };
  } else {
    const collected = await d.collectCompetitorFootprints(site, { maxCompetitors });
    report.costUsd += collected.costUsd || 0;
    report.footprint = {
      ran: true, ok: collected.ok, collected: collected.collected, skipped: collected.skipped,
      stoppedEarly: collected.stoppedEarly, costUsd: collected.costUsd || 0,
    };
  }

  // --- Stage 3: opportunities (free) ---------------------------------------
  const footprintRows = await d.getAllLatestFootprints(site.id);
  if (!footprintRows.length) {
    report.opportunities = { ran: false, reason: 'no_footprint_yet' };
    return report;
  }

  const { start, end } = windowDates(OWN_QUERY_WINDOW_DAYS);
  const queryPages = await d.getQueryPageMetrics(site.id, start, end).catch(() => []);
  const existingGaps = await d.getKeywordGaps(site.id, null).catch(() => []);
  const learnedMultipliers = await d.getLearnedMultipliers(site.id).catch(() => ({}));

  const { opportunities, rejected } = buildOpportunities({
    footprintRows,
    ourQueries: queryPages.map((r) => ({ query: r.query, avg_position: r.avgPosition, impressions: r.impressions, page: r.page })),
    ourPages: pagesWithKeywords(queryPages),
    existingGaps,
    serviceTerms: services.terms,
    // The markets this client targets: what makes a keyword location work rather than a modifier.
    // Declared places first: "estate agents northampton" is location work BECAUSE Northampton is a place this client
    // works in, which a country name alone could never tell it.
    locationNames: [
      ...placeNames(site),
      ...(deps.resolveSiteLocations || resolveSiteLocations)(site).map((l) => LOCATION_NAMES[l.locationCode]).filter(Boolean),
    ],
    learnedMultipliers,
    authorityScore: site.authority_score ?? null,
  });

  const top = opportunities.slice(0, maxOpportunities);
  let written = { inserted: 0, updated: 0 };
  if (save && top.length) written = await d.saveCompetitorOpportunities(site.id, top);

  report.opportunities = {
    ran: true, built: opportunities.length, kept: top.length, written,
    byType: countBy(top, (o) => o.opportunityType),
    rejected: countBy(rejected, (r) => r.reason),
    learnedMultipliers,
    top: top.slice(0, 10).map((o) => ({
      keyword: o.keyword, type: o.opportunityType, score: o.score, confidence: o.confidence,
      existingPage: o.existingPageMatch, reason: o.reason,
    })),
  };
  return report;
}

// Our own pages and the keywords they already rank for — the input the improve-vs-create decision needs. Built from
// the query/page metrics we already have rather than a new crawl: a page that ranks for a keyword is, by definition,
// a page that targets it.
function pagesWithKeywords(queryPages) {
  const byPage = new Map();
  for (const r of queryPages) {
    if (!r.page) continue;
    if (!byPage.has(r.page)) byPage.set(r.page, { url: r.page, keywords: [] });
    byPage.get(r.page).keywords.push(r.query);
  }
  return [...byPage.values()];
}

function isStale(rows, days) {
  const newest = rows
    .map((r) => (r.last_analyzed_at || r.first_seen_at ? new Date(r.last_analyzed_at || r.first_seen_at).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  if (!newest) return true;
  return Date.now() - newest > days * 86400000;
}

function windowDates(days) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function countBy(rows, keyOf) {
  const out = {};
  for (const r of rows) {
    const k = keyOf(r) || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
