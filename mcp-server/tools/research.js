import { z } from 'zod';
import { jsonResult, withErrorHandling } from './shared.js';
import { getSiteById } from '../../server/store/read.js';
import { fetchSerpCompetitors, fetchRankedKeywords, fetchRelevantPages } from '../../server/ingest/competitor-providers/dataforseo-labs.js';
import { resolveSiteLocations } from '../../server/agents/lib/site-locations.js';
import { resolveMarketServiceTerms } from '../../server/agents/lib/market-seed-terms.js';
import { buildMarketSeeds } from '../../server/agents/lib/competitor-market-discovery.js';
import { targetPlaces } from '../../server/agents/lib/local-seo.js';
import { getAllLatestFootprints, getFootprintChange, getNewlyGainedKeywords } from '../../server/store/competitor-footprint.js';
import { listCompetitorsByKind } from '../../server/store/competitor-profiles.js';
import { listCompetitorOpportunities } from '../../server/store/competitor-opportunities.js';
import { getTrackedRankMovement, getOwnRankHistory, listTrackedKeywords, addTrackedKeyword, trackedKeywordCapacity } from '../../server/store/rank-tracking.js';
import { getMonthSpendUsd, getMonthlyBudgetUsd, listSpendByEndpoint } from '../../server/store/provider-spend.js';

// On-demand market research, so an AI assistant can answer "what does this rival rank for?" when the question is
// asked instead of waiting for the next scheduled job.
//
// TWO CLASSES OF TOOL HERE, and the split is deliberate because one of them spends money:
//
//   FREE  — read what this project already paid for: stored footprints, movement, opportunities, spend. Registered
//           for every token, like every other read-only tool.
//   PAID  — make a live DataForSEO call. Registered ONLY at the automation tier and above, every call goes through
//           the budgeted client (so it lands in the spend ledger and is refused over budget), and each one reports
//           the cost it actually incurred in its own result. An agent can therefore never spend silently.
//
// A paid tool also refuses rather than guesses: no market configured, no service terms, or over budget all come back
// as an explicit reason the assistant can relay, never as an empty result that reads like "no competitors".

const DOMAIN = z.string().trim().min(3).max(253).describe('A competitor domain, e.g. "rival.com" — no scheme or path.');

/** Free tools: everything already stored. Safe for any token. */
export function registerResearchReadTools(server, siteId) {
  server.registerTool('get_market_competitors', {
    description: 'This project\'s classified competitors: business rivals, organic competitors (directories, publishers) and keyword-specific domains, with the evidence each label was based on. Reads stored data — no cost.',
    inputSchema: {
      kind: z.enum(['business', 'organic', 'keyword_specific']).default('business').describe('Which kind to list. "business" are genuine rivals; the others are context, not competitors.'),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, withErrorHandling('get_market_competitors', async ({ kind, limit }) =>
    jsonResult(await listCompetitorsByKind(siteId, kind, { limit }))));

  server.registerTool('get_competitor_footprint', {
    description: 'The keywords this project\'s business rivals rank for, from the latest stored collection, with position, search volume and difficulty. Reads stored data — no cost.',
    inputSchema: { limit: z.number().int().min(1).max(2000).default(200) },
  }, withErrorHandling('get_competitor_footprint', async ({ limit }) =>
    jsonResult(await getAllLatestFootprints(siteId, { limit }))));

  server.registerTool('get_competitor_movement', {
    description: 'What changed for one competitor between its two most recent collections: keywords gained, lost, improved and declined, plus the new keywords themselves. Returns null when only one collection exists — nothing to compare is not the same as no change. Reads stored data — no cost.',
    inputSchema: { domain: DOMAIN, newKeywordLimit: z.number().int().min(1).max(200).default(25) },
  }, withErrorHandling('get_competitor_movement', async ({ domain, newKeywordLimit }) => jsonResult({
    change: await getFootprintChange(siteId, domain),
    newlyGained: await getNewlyGainedKeywords(siteId, domain, { limit: newKeywordLimit }),
  })));

  server.registerTool('get_growth_opportunities', {
    description: 'Scored opportunities built from competitor evidence, each with what to do about it (improve an existing page, a new page, a service-and-location page, close a position gap), the evidence behind it, and where it stands in the lifecycle. Reads stored data — no cost.',
    inputSchema: {
      status: z.enum(['pending_review', 'accepted', 'dismissed']).default('pending_review'),
      opportunityType: z.enum(['missing', 'position_gap', 'topic_gap', 'service_location', 'improve_page', 'new_page']).optional(),
      limit: z.number().int().min(1).max(200).default(25),
    },
  }, withErrorHandling('get_growth_opportunities', async ({ status, opportunityType, limit }) =>
    jsonResult(await listCompetitorOpportunities(siteId, { status, opportunityType: opportunityType ?? null, limit }))));

  server.registerTool('get_rank_movement', {
    description: 'Every tracked keyword with its latest position and the change since the previous check. A keyword the site does not rank for reports position null, which is a real answer — never treat it as position 0. Reads stored data — no cost.',
    inputSchema: {},
  }, withErrorHandling('get_rank_movement', async () => jsonResult(await getTrackedRankMovement(siteId))));

  server.registerTool('get_rank_history', {
    description: "This site's own position history for one tracked keyword, newest first. Reads stored data — no cost.",
    inputSchema: {
      keyword: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(520).default(52),
    },
  }, withErrorHandling('get_rank_history', async ({ keyword, limit }) =>
    jsonResult(await getOwnRankHistory(siteId, keyword, { limit }))));

  server.registerTool('list_tracked_keywords', {
    description: 'The keywords this project has chosen to watch, with how many slots its ceiling still allows. Reads stored data — no cost.',
    inputSchema: { includeInactive: z.boolean().default(false) },
  }, withErrorHandling('list_tracked_keywords', async ({ includeInactive }) => jsonResult({
    keywords: await listTrackedKeywords(siteId, { includeInactive }),
    capacity: await trackedKeywordCapacity(siteId),
  })));

  server.registerTool('get_provider_spend', {
    description: "What this project has spent with external data providers this month, its monthly cap (null means no cap), and a breakdown by endpoint. Read this before asking for any paid research.",
    inputSchema: { days: z.number().int().min(1).max(366).default(30) },
  }, withErrorHandling('get_provider_spend', async ({ days }) => jsonResult({
    dataforseoThisMonthUsd: await getMonthSpendUsd(siteId, 'dataforseo'),
    monthlyBudgetUsd: await getMonthlyBudgetUsd(siteId, 'dataforseo'),
    byEndpoint: await listSpendByEndpoint(siteId, { days }),
  })));
}

/**
 * Paid tools: each makes a live provider call. Registered at the automation tier and above only.
 *
 * Every handler resolves the project's own market and vocabulary rather than taking them from the caller, so an
 * assistant cannot research the wrong market by passing a wrong location, and reports `costUsd` so the spend is
 * visible in the answer itself.
 */
export function registerResearchLiveTools(server, siteId) {
  const marketFor = async () => {
    const site = await getSiteById(siteId);
    const [primary] = resolveSiteLocations(site);
    return { site, locationCode: primary?.locationCode ?? null, languageCode: primary?.languageCode ?? 'en' };
  };

  server.registerTool('research_market_competitors', {
    description: 'COSTS MONEY (one DataForSEO call). Finds the domains competing across the keywords this business should be found for — including searches it has no presence for at all, which its own Search Console data cannot show. Refused with a reason when the project has no verified services or is over its monthly budget. Check get_provider_spend first.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(50).describe('How many competing domains to return.') },
  }, withErrorHandling('research_market_competitors', async ({ limit }) => {
    const { site, locationCode, languageCode } = await marketFor();
    if (!locationCode) return jsonResult({ ok: false, reason: 'no_market_configured', detail: 'This project has no target market set, so a market cannot be researched.' });
    const services = await resolveMarketServiceTerms(siteId);
    if (!services.terms.length) {
      return jsonResult({ ok: false, reason: 'no_services_known', detail: 'This project has no verified capabilities, profile topics or confirmed offerings, so there is no market to research. Researching from a guess would describe the wrong market.' });
    }
    // The same seeds the scheduled discovery uses: services crossed with the client's declared places when it has
    // them, so an assistant researching a local client asks about "estate agents northampton", not a national term.
    const seeds = buildMarketSeeds({ services: services.terms, declaredPlaces: targetPlaces(site) });
    const out = await fetchSerpCompetitors(seeds, { siteId, locationCode, languageCode, limit });
    return jsonResult({ ...out, seedTerms: seeds, seedSource: services.source, site: site.name });
  }));

  server.registerTool('research_competitor_keywords', {
    description: 'COSTS MONEY (one DataForSEO call). Everything one competitor domain ranks for in this project\'s market, filtered to the services this business actually offers so the result is usable rather than noise. Check get_provider_spend first.',
    inputSchema: {
      domain: DOMAIN,
      limit: z.number().int().min(1).max(1000).default(300),
      minVolume: z.number().int().min(0).max(100000).default(10).describe('Ignore keywords with less measured monthly demand than this.'),
      maxPosition: z.number().int().min(1).max(100).default(30).describe('Only keywords the competitor ranks for within this position.'),
    },
  }, withErrorHandling('research_competitor_keywords', async ({ domain, limit, minVolume, maxPosition }) => {
    const { locationCode, languageCode } = await marketFor();
    if (!locationCode) return jsonResult({ ok: false, reason: 'no_market_configured' });
    const services = await resolveMarketServiceTerms(siteId);
    const out = await fetchRankedKeywords(domain, {
      siteId, locationCode, languageCode, limit, minVolume, maxPosition, filterTerms: services.terms,
    });
    return jsonResult({ ...out, filteredTo: services.terms, filterSource: services.source });
  }));

  server.registerTool('research_competitor_pages', {
    description: "COSTS MONEY (one DataForSEO call). Which of a competitor's pages carry its organic traffic, so a recommendation can point at the page type that works rather than a bare keyword. Check get_provider_spend first.",
    inputSchema: { domain: DOMAIN, limit: z.number().int().min(1).max(200).default(50) },
  }, withErrorHandling('research_competitor_pages', async ({ domain, limit }) => {
    const { locationCode, languageCode } = await marketFor();
    if (!locationCode) return jsonResult({ ok: false, reason: 'no_market_configured' });
    return jsonResult(await fetchRelevantPages(domain, { siteId, locationCode, languageCode, limit }));
  }));

  server.registerTool('track_keyword', {
    description: "Start watching a keyword's position over time. Bounded by this project's own keyword ceiling: when the ceiling is full the call is refused with reason \"cap_reached\" rather than silently raising the spend. Costs nothing by itself; each tracked keyword is checked on the project's own cadence.",
    inputSchema: {
      keyword: z.string().trim().min(1).max(200),
      reason: z.enum(['user_request', 'opportunity', 'keyword_gap']).default('user_request').describe('Why this keyword is being watched.'),
    },
  }, withErrorHandling('track_keyword', async ({ keyword, reason }) => {
    const { locationCode, languageCode } = await marketFor();
    if (!locationCode) return jsonResult({ added: false, reason: 'no_market_configured' });
    const result = await addTrackedKeyword(siteId, keyword, { locationCode, languageCode, source: reason });
    return jsonResult({ ...result, capacity: await trackedKeywordCapacity(siteId) });
  }));
}
