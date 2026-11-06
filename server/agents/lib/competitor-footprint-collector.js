import { fetchRankedKeywords, fetchRelevantPages } from '../../ingest/competitor-providers/dataforseo-labs.js';
import { resolveSiteLocations } from './site-locations.js';
import { resolveMarketServiceTerms } from './market-seed-terms.js';
import {
  saveCompetitorKeywords, saveCompetitorPages, recordFootprintRun, listCompetitorsNeedingFootprint,
} from '../../store/competitor-footprint.js';

// Collects the keyword and page footprint of this project's business rivals (Phase 3).
//
// This is the first part of the system that spends money per run rather than per month, so every guard is deliberate:
//   - only `business` competitors are collected (a directory's keyword list is not a growth plan)
//   - a competitor collected within the freshness window is skipped, not re-bought
//   - keywords are filtered to the client's own market vocabulary before storage, so a large rival's unrelated
//     footprint cannot flood the opportunity queue
//   - the per-run competitor count is capped, and a budget refusal ends the run cleanly for every remaining competitor
//   - every outcome is recorded (ok / partial / failed / budget_refused), so "nothing collected" always has a reason
//
// Writes snapshots and run records only. It does not create opportunities, recommendations or drafts: that is Phase 4,
// behind the existing gates.

const DEFAULT_FRESHNESS_DAYS = 30;
const DEFAULT_MAX_COMPETITORS = 5;
const KEYWORDS_PER_COMPETITOR = 300;
const PAGES_PER_COMPETITOR = 50;

/**
 * Collect footprints for one project.
 *
 * Returns { ok, collected[], skipped[], costUsd, stoppedEarly } — `stoppedEarly` names the reason a run ended before
 * every due competitor was collected (today only 'budget_refused'), so a short run is never mistaken for a complete one.
 */
export async function collectCompetitorFootprints(site, {
  maxCompetitors = DEFAULT_MAX_COMPETITORS,
  freshnessDays = DEFAULT_FRESHNESS_DAYS,
  includePages = true,
  deps = {},
} = {}) {
  const listDue = deps.listCompetitorsNeedingFootprint || listCompetitorsNeedingFootprint;
  const fetchKeywords = deps.fetchRankedKeywords || fetchRankedKeywords;
  const fetchPages = deps.fetchRelevantPages || fetchRelevantPages;
  const saveKeywords = deps.saveCompetitorKeywords || saveCompetitorKeywords;
  const savePages = deps.saveCompetitorPages || saveCompetitorPages;
  const recordRun = deps.recordFootprintRun || recordFootprintRun;
  const serviceTerms = deps.resolveMarketServiceTerms || resolveMarketServiceTerms;
  const locations = (deps.resolveSiteLocations || resolveSiteLocations)(site);

  const services = await serviceTerms(site.id);
  if (!services.terms.length) {
    // Without the client's own vocabulary there is nothing to filter a rival's footprint against, and an unfiltered
    // footprint is noise we would both pay for and have to review. Refusing is the cheaper answer.
    return { ok: false, skipped: [{ reason: 'no_services_known' }], collected: [], costUsd: 0, stoppedEarly: null };
  }

  const due = await listDue(site.id, { maxAgeDays: freshnessDays, limit: maxCompetitors });
  if (!due.length) {
    return { ok: true, collected: [], skipped: [{ reason: 'all_fresh_or_no_business_competitors' }], costUsd: 0, stoppedEarly: null };
  }

  const collected = [];
  const skipped = [];
  let costUsd = 0;
  let stoppedEarly = null;

  for (const competitor of due) {
    if (stoppedEarly) {
      skipped.push({ domain: competitor.domain, reason: stoppedEarly });
      continue;
    }
    const capturedAt = new Date(); // one timestamp per competitor: its snapshot is one comparable set
    let keywordsStored = 0;
    let pagesStored = 0;
    const failures = [];

    for (const location of locations) {
      const res = await fetchKeywords(competitor.domain, {
        siteId: site.id, locationCode: location.locationCode, languageCode: location.languageCode,
        limit: KEYWORDS_PER_COMPETITOR, filterTerms: services.terms,
      });
      if (typeof res.costUsd === 'number') costUsd += res.costUsd;
      if (!res.ok) {
        failures.push(`${location.locationCode}: ${res.reason}`);
        if (res.reason === 'budget_refused') stoppedEarly = 'budget_refused';
        break;
      }
      if (res.keywords.length) keywordsStored += await saveKeywords(site.id, competitor.domain, res.keywords, { capturedAt });
    }

    if (includePages && !stoppedEarly && keywordsStored) {
      for (const location of locations) {
        const res = await fetchPages(competitor.domain, {
          siteId: site.id, locationCode: location.locationCode, languageCode: location.languageCode, limit: PAGES_PER_COMPETITOR,
        });
        if (typeof res.costUsd === 'number') costUsd += res.costUsd;
        if (!res.ok) {
          failures.push(`pages ${location.locationCode}: ${res.reason}`);
          if (res.reason === 'budget_refused') stoppedEarly = 'budget_refused';
          break;
        }
        if (res.pages.length) pagesStored += await savePages(site.id, competitor.domain, res.pages, { locationCode: location.locationCode, capturedAt });
      }
    }

    const status = statusFor({ keywordsStored, failures, stoppedEarly });
    await recordRun(site.id, competitor.domain, {
      status, keywordsStored, pagesStored, collectedAt: capturedAt,
      detail: failures.length ? failures.join('; ') : null,
    });
    if (status === 'ok' || status === 'partial') {
      collected.push({ domain: competitor.domain, keywordsStored, pagesStored, status });
    } else {
      skipped.push({ domain: competitor.domain, reason: status, detail: failures.join('; ') || null });
    }
  }

  return { ok: true, collected, skipped, costUsd, stoppedEarly, serviceTermCount: services.terms.length };
}

// A run that stored something but also hit a failure is 'partial', not 'ok': the next run must be allowed to retry it
// (listCompetitorsNeedingFootprint treats anything other than 'ok' as due) rather than trust an incomplete footprint
// for a month.
function statusFor({ keywordsStored, failures, stoppedEarly }) {
  if (stoppedEarly === 'budget_refused' && !keywordsStored) return 'budget_refused';
  if (!keywordsStored) return 'failed';
  return failures.length ? 'partial' : 'ok';
}
