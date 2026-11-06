import { analyzePageUrl } from './page-content.js';
import { normalizeCompetitorDomain, queryRelevanceOverlap } from './competitor-analysis.js';
import { classifyAll } from './competitor-classifier.js';
import { resolveSiteLocations, LOCATION_NAMES } from './site-locations.js';
import { ownDomains } from './site-domain.js';
import { targetPlaces, placeSeedPhrases } from './local-seo.js';
import { fetchSerpCompetitors } from '../../ingest/competitor-providers/dataforseo-labs.js';

// Market-wide competitor discovery (Phase 2).
//
// The existing pipeline (competitor-analysis.js) can only find rivals inside the site's OWN Search Console footprint —
// it tallies who else ranks for queries this site already ranks for — or else asks an LLM to name some. Both miss the
// case that matters most for growth: a rival who dominates the searches this site has no presence for at all.
//
// This module asks the other question. Seeds are what the business actually sells crossed with where it sells, taken
// from the site's own verified context, so the keyword set is the market rather than the current footprint. The
// provider returns the domains ranking across that set; each is then measured against real signals and classified
// (competitor-classifier.js) into business / organic / keyword_specific.
//
// Costs money, so: one paid call per location per run, every call recorded per site_id and refused when the project is
// over budget (migration 231). Reading a candidate's homepage is free.
//
// Nothing here writes to the database or ships work: it returns a decision set for the caller to persist and for a
// human to read. Deps are injectable so the whole thing is testable without a network or a database.

const MAX_SEED_KEYWORDS = 60;   // per location; the provider accepts 200, but each keyword widens the result noise
const MAX_CANDIDATES_TO_FETCH = 12; // homepages read per run (free, but each is an outbound request)
const MIN_PRESENCE_SHARE = 0.05;    // below this a domain is noise in this market, not a participant

/**
 * Build the keyword set that describes this business's market: each service crossed with each target location, plus
 * the bare service terms. Deterministic, and derived only from the site's own verified context — never invented.
 *
 * Place names are stripped of the article LOCATION_NAMES carries for prose ("the United States"), since a searcher
 * types "dental implants united states", not "dental implants the united states".
 */
export function buildMarketSeeds({ services = [], locationNames = [], declaredPlaces = [], max = MAX_SEED_KEYWORDS } = {}) {
  // A local client works in named places. When it has declared some, THOSE are the market: "estate agents Northampton"
  // is the search its customers type, and "estate agents United Kingdom" is a term it can never win. Primary place
  // first for every service, so a cap trims the neighbours rather than the home town.
  if (declaredPlaces.length) return placeSeedPhrases(services, declaredPlaces, { max });
  const clean = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const svc = [...new Set(services.map(clean).filter((s) => s.length >= 3))];
  const places = [...new Set(locationNames.map((n) => clean(n).replace(/^the /, '')).filter(Boolean))];
  const seeds = [];
  for (const s of svc) {
    seeds.push(s);
    for (const p of places) seeds.push(`${s} ${p}`);
  }
  return [...new Set(seeds)].slice(0, max);
}

/**
 * Discover and classify this project's market competitors.
 *
 * Returns { ok, seeds, perLocation[], candidates[], classified, costUsd, skipped } — `skipped` explains a run that
 * made no paid call (no services known, no provider, over budget), so a caller can report a real reason instead of an
 * empty result that looks like "no competitors".
 */
export async function discoverMarketCompetitors(site, {
  services = [],
  ownTopQueries = [],
  maxBusiness = 5,
  deps = {},
} = {}) {
  const fetchCompetitors = deps.fetchSerpCompetitors || fetchSerpCompetitors;
  const fetchPage = deps.analyzePageUrl || analyzePageUrl;
  const locations = (deps.resolveSiteLocations || resolveSiteLocations)(site);
  const own = ownDomainSet(site);

  // resolveSiteLocations returns codes, not names; LOCATION_NAMES is the repo's own code -> name map. A location with
  // no listed name still gets its paid call below — only the "service + place" seed phrasing needs a name.
  const locationNames = locations.map((l) => LOCATION_NAMES[l.locationCode]).filter(Boolean);
  const seeds = buildMarketSeeds({ services, locationNames, declaredPlaces: targetPlaces(site) });
  if (!seeds.length) {
    return { ok: false, skipped: 'no_services_known', seeds: [], perLocation: [], candidates: [], classified: emptyClassified(), costUsd: 0 };
  }

  // One paid call per location: a market is per place, and merging locations into one call would blur two markets.
  const perLocation = [];
  let costUsd = 0;
  const byDomain = new Map();
  for (const location of locations) {
    const res = await fetchCompetitors(seeds, {
      siteId: site.id, locationCode: location.locationCode, languageCode: location.languageCode,
    });
    perLocation.push({ locationCode: location.locationCode, ok: res.ok, reason: res.reason || null, found: res.competitors?.length || 0 });
    if (typeof res.costUsd === 'number') costUsd += res.costUsd;
    if (!res.ok) continue;
    for (const c of res.competitors) {
      if (!c.domain || own.has(c.domain)) continue;
      if (c.presenceShare != null && c.presenceShare < MIN_PRESENCE_SHARE) continue;
      // A domain seen in two markets keeps its strongest presence, and records both.
      const prev = byDomain.get(c.domain);
      if (!prev || (c.presenceShare ?? 0) > (prev.presenceShare ?? 0)) {
        byDomain.set(c.domain, { ...c, locationCodes: [...new Set([...(prev?.locationCodes || []), location.locationCode])] });
      } else {
        prev.locationCodes = [...new Set([...prev.locationCodes, location.locationCode])];
      }
    }
  }

  if (!byDomain.size) {
    const refused = perLocation.some((l) => l.reason === 'budget_refused');
    return {
      ok: !refused, skipped: refused ? 'budget_refused' : (perLocation.every((l) => !l.ok) ? 'provider_unavailable' : null),
      seeds, perLocation, candidates: [], classified: emptyClassified(), costUsd,
    };
  }

  // Free grounding: read each candidate's own homepage and measure how much of this site's real searches it actually
  // talks about. An unreadable homepage leaves the signal null, which keeps the candidate out of 'business'.
  const candidates = [];
  for (const c of [...byDomain.values()].sort((a, b) => (b.presenceShare ?? 0) - (a.presenceShare ?? 0)).slice(0, MAX_CANDIDATES_TO_FETCH)) {
    const fetched = await fetchPage(`https://${c.domain}`).catch(() => null);
    // analyzePageUrl returns { ok, analysis: {...} } — the page's fields live on `.analysis`, NOT on the result. Reading
    // them off the top level (as this used to) found nothing on every real page, so a competitor's service overlap was
    // always null and no rival could ever be classified as a business competitor. The earlier tests passed only
    // because their fake returned the same wrong flat shape.
    const page = fetched?.ok ? fetched.analysis : null;
    let serviceTermOverlap = null;
    let homepageText = null;
    if (page && (page.bodyText || page.title)) {
      homepageText = `${page.title || ''} ${page.metaDescription || ''} ${page.bodyText || ''}`;
      const probe = ownTopQueries.length ? ownTopQueries : seeds;
      const overlap = queryRelevanceOverlap(page, probe, [...own][0] || null);
      serviceTermOverlap = overlap.queriesChecked > 0
        ? Number((overlap.overlapCount / overlap.queriesChecked).toFixed(3))
        : null; // nothing answerable was checked: no evidence, not zero evidence
    }
    candidates.push({
      domain: c.domain,
      serpQueryHits: c.keywordsRanked,
      queriesChecked: c.keywordsAsked,
      presenceShare: c.presenceShare,
      locationCodes: c.locationCodes,
      estimatedTrafficVolume: c.estimatedTrafficVolume,
      serviceTermOverlap,
      locationMatch: c.locationCodes?.length ? true : null,
      homepageText,
      homepageRead: homepageText != null,
    });
  }

  const classified = classifyAll(candidates, { maxBusiness });
  return { ok: true, skipped: null, seeds, perLocation, candidates: candidates.map(stripText), classified: stripClassifiedText(classified), costUsd };
}

// Every hostname this project counts as its own, so it can never be reported as its own competitor. ownDomains() is
// the explicit, never-guessing set (website_domain + additional_own_domains); a site that has only a Search Console
// property configured would otherwise match nothing, because a GSC domain property carries an `sc-domain:` prefix that
// is not a hostname. Both are included rather than one or the other, since a site can legitimately have either.
function ownDomainSet(site) {
  const set = new Set();
  for (const d of ownDomains(site) || []) {
    const n = normalizeCompetitorDomain(d);
    if (n) set.add(n);
  }
  const fromProperty = normalizeCompetitorDomain(String(site?.gsc_property || '').replace(/^sc-domain:/, ''));
  if (fromProperty) set.add(fromProperty);
  return set;
}

// The homepage text was only ever needed to measure signals; it must not travel further (it is another company's page
// content, and it would bloat every stored evidence record).
function stripText({ homepageText, ...rest }) { return rest; }
function stripClassifiedText(c) {
  const clean = (list) => list.map((x) => ({ ...x, evidence: x.evidence ? stripText(x.evidence) : x.evidence }));
  return {
    business: clean(c.business), overflowBusiness: clean(c.overflowBusiness),
    organic: clean(c.organic), keywordSpecific: clean(c.keywordSpecific), excluded: clean(c.excluded),
  };
}
function emptyClassified() {
  return { business: [], overflowBusiness: [], organic: [], keywordSpecific: [], excluded: [] };
}
