import { getSiteById } from '../store/read.js';
import { getProductGrowthConfig } from '../store/product-growth-config.js';
import { createProspect, getConversionEvidence } from '../store/prospects.js';
import { getCompetitorProvider, competitorProviderConfigured } from '../ingest/competitor-providers/index.js';
import { resolveSiteLocations } from './lib/site-locations.js';
import { fetchHomepageBodyText, findMatchingPhrase } from './lib/homepage-text.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';

// Universal Product Growth mode, Phase 3 — Product Demand Intelligence.
// Generic across any product tenant: which industries/markets/ICP signals
// to search under are entirely read from THIS site's own
// product_growth_config row (167/168), never a hardcoded rule — the
// "multi-location business" example in the spec is Zenly's own config
// choice, not something this file knows about.
//
// Own opt-in flag (product_growth_config.prospect_discovery_enabled) —
// deliberately never gated on DataForSEO credentials merely being present,
// so enabling it for one product site never silently starts spending
// another product's competitor-intelligence budget. Real SERP calls only
// happen once a month (see job.js's runProspectDiscoveryIfDue), same cost
// discipline as authority/competitor-intelligence.
export const meta = {
  id: 'prospect-discovery',
  name: 'Prospect Discovery Agent',
  description: 'Finds real, evidence-backed prospect businesses matching this product\'s own configured ICP — never a guess, never fabricated.',
  category: 'seo',
  version: 1,
  dataSources: [
    { id: 'serp-competitor-discovery', status: competitorProviderConfigured() ? 'connected' : 'not-connected', description: 'Real organic SERP results for the site\'s configured industries/markets — the discovery seed.' },
  ],
};

const MAX_INDUSTRIES_PER_RUN = 3;
const MAX_LOCATIONS_PER_RUN = 2;
const MAX_CANDIDATE_DOMAINS_PER_QUERY = 5;


export async function run({ siteId }) {
  const [site, config] = await Promise.all([getSiteById(siteId), getProductGrowthConfig(siteId)]);

  if (!config?.prospect_discovery_enabled) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'Prospect discovery is not enabled for this site (Clients → Product Growth tab).',
      generatedAt: new Date().toISOString(),
    };
  }
  if (!competitorProviderConfigured()) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'No SERP provider configured — prospect discovery has no real data source to search with.',
      generatedAt: new Date().toISOString(),
    };
  }
  const icpSignals = config.icp_signals || [];

  // CRM-outcome feedback loop (Product Growth spec §7): real converted
  // prospects from past runs bias which of THIS site's own configured
  // industries get checked first when there are more configured than the
  // per-run cap — never a fabricated preference, and a site with no
  // conversions yet (the common case early on) falls back to configured
  // order exactly as before this existed.
  const conversionEvidence = await getConversionEvidence(siteId);
  const convertedIndustries = new Set(conversionEvidence.filter((c) => c.convertedCount > 0).map((c) => c.industry));
  const orderedIndustries = [...(config.industries || [])].sort((a, b) => Number(convertedIndustries.has(b)) - Number(convertedIndustries.has(a)));
  const industries = orderedIndustries.slice(0, MAX_INDUSTRIES_PER_RUN);
  if (!industries.length || !icpSignals.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No target industries and/or ICP qualification signals configured — nothing real to qualify a prospect against.',
      generatedAt: new Date().toISOString(),
    };
  }

  const provider = getCompetitorProvider();
  const locations = resolveSiteLocations(site).slice(0, MAX_LOCATIONS_PER_RUN);
  const ownDomain = (site.website_domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '');

  const candidates = []; // { companyName, domain, industry, market, queryUsed }
  const seenDomains = new Set();

  for (const industry of industries) {
    for (const location of locations) {
      const searchQuery = `${industry} ${icpSignals[0]}`.trim();
      let results;
      try {
        results = await provider.fetchRankings(searchQuery, location);
      } catch (err) {
        console.warn(`[prospect-discovery] site ${siteId}: SERP fetch failed for "${searchQuery}":`, err.message);
        continue;
      }
      for (const r of (results || []).slice(0, MAX_CANDIDATE_DOMAINS_PER_QUERY)) {
        if (!r.domain || r.domain === ownDomain || seenDomains.has(r.domain)) continue;
        seenDomains.add(r.domain);
        candidates.push({ domain: r.domain, url: r.url, position: r.position, industry, market: `${location.locationCode}/${location.languageCode}`, queryUsed: searchQuery });
      }
    }
  }

  const qualified = [];
  for (const c of candidates) {
    const fetched = await fetchHomepageBodyText(c.url);
    if (!fetched) continue; // no real page content to check evidence against — skip, never guess
    const matchedSignal = findMatchingPhrase(fetched.text, icpSignals);
    if (!matchedSignal) continue; // real page, but no real evidence of the configured signal — not fabricated as a prospect

    const evidence = { sourceUrl: fetched.url, searchQuery: c.queryUsed, serpPosition: c.position, matchedSignal };
    const saved = await createProspect(siteId, {
      companyName: c.domain,
      market: c.market,
      industry: c.industry,
      qualificationReason: `Real homepage text at ${fetched.url} contains the configured ICP signal "${matchedSignal}".`,
      evidence,
      confidence: 'medium', // single real-signal match, not multi-signal corroborated
      recommendedSegment: c.industry,
    });
    if (saved) qualified.push({ ...saved, evidence });
  }

  const priorities = priorityByRank(qualified);
  const findings = qualified.map((q, i) => makeFinding({
    id: `prospect-discovery:${q.id}`,
    evidence: q.evidence,
    whyItMatters: `${q.companyName} matched the configured ICP signal "${q.evidence.matchedSignal}" for "${q.industry}" — a real, evidence-backed prospect, not yet approved for CRM handoff.`,
    priority: priorities[i],
    recommendedAction: null, // human approval (Demand page), never auto-drafted
    expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'estimate' },
  }));

  const facts = {
    candidatesChecked: candidates.length,
    qualifiedCount: qualified.length,
    industries, icpSignals,
    conversionEvidence, // real past-outcome evidence this run's industry ordering was weighted by
    findings,
  };

  return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
}
