// Resolves which DataForSEO location(s) a site's own real target market
// calls for, replacing the single hardcoded COMPETITOR_LOCATION_CODE env var
// every DataForSEO caller used to query for every tenant regardless of where
// that tenant actually does business (see migration 159 for the incident:
// a UK-only client and a Nepal-based one were both getting US keyword
// demand). A site with no country_code configured resolves to exactly the
// same single global-default location as before this module existed — no
// existing site regresses.

const DEFAULT_LOCATION_CODE = Number(process.env.COMPETITOR_LOCATION_CODE || 2840); // 2840 = United States
const DEFAULT_LANGUAGE_CODE = process.env.COMPETITOR_LANGUAGE_CODE || 'en';

// Returns an ordered array of {locationCode, languageCode} to query — the
// site's own real market first when it has one, so a caller that only wants
// ONE location (e.g. location-service-gap.js, which already has a place
// name baked into its own seed terms) can just take locations[0]. A caller
// that wants full coverage (e.g. keyword-demand.js) can iterate the whole
// array and merge results.
export function resolveSiteLocations(site) {
  const globalLocation = { locationCode: DEFAULT_LOCATION_CODE, languageCode: DEFAULT_LANGUAGE_CODE };
  const ownLocation = site?.country_code
    ? { locationCode: Number(site.country_code), languageCode: site.language_code || DEFAULT_LANGUAGE_CODE }
    : null;

  // An explicit multi-market list (migration 162) takes priority over
  // target_scope entirely — for a business that genuinely serves several
  // real markets at once (e.g. Zunkiree Labs itself: Nepal-based, but
  // serving clients in the US/UK/India/Australia/Canada/Switzerland/
  // Netherlands/Germany too), neither 'hybrid' (home market + one shared
  // default) nor 'global' (one shared default alone) can express that;
  // this can name exactly the real markets that matter, of any length.
  // Each entry carries its OWN languageCode (not one site-wide language)
  // because DataForSEO's Keyword Data product validates language against
  // location per request — Germany/Switzerland reject 'en' outright and
  // need 'de', the Netherlands needs 'nl' (confirmed live) — a single
  // language_code field can't serve a mixed-language market list.
  if (Array.isArray(site?.target_markets) && site.target_markets.length) {
    return site.target_markets
      .filter((m) => m && m.locationCode != null)
      .map((m) => ({ locationCode: Number(m.locationCode), languageCode: m.languageCode || DEFAULT_LANGUAGE_CODE }));
  }

  switch (site?.target_scope) {
    case 'local': return ownLocation ? [ownLocation] : [globalLocation];
    case 'hybrid': return ownLocation ? [ownLocation, globalLocation] : [globalLocation];
    default: return [globalLocation]; // 'global' (default), or no target_scope set at all
  }
}

// Friendly names for prompt text only (the keyword LLM-guess fallback and the
// AI-mention prompt generator) — real requests to DataForSEO always use the
// numeric locationCode itself, never a name. Only needs to cover markets this
// codebase actually configures a site for (migrations 159/162); an unlisted
// code degrades to "location code N" in the prompt, still functional.
export const LOCATION_NAMES = {
  2840: 'the United States', 2826: 'the United Kingdom', 2356: 'India',
  2036: 'Australia', 2124: 'Canada', 2524: 'Nepal', 2756: 'Switzerland',
  2528: 'the Netherlands', 2276: 'Germany',
};

// ISO 3166-1 alpha-2 codes for the same markets: the form a model API's own location hint takes (OpenAI web search
// `user_location.country`). An unlisted code has no entry, so the caller sends no location rather than a wrong one.
export const LOCATION_ISO = {
  2840: 'US', 2826: 'GB', 2356: 'IN', 2036: 'AU', 2124: 'CA', 2524: 'NP', 2756: 'CH', 2528: 'NL', 2276: 'DE',
};

// The single country an AI-answer probe should be asked from, or null. Only a site whose own configuration resolves to
// exactly one real country gets one: a local business (target_scope 'local' with its own country_code) or an explicit
// one-market list. A global, hybrid or multi-market site, or a local site with no country_code (which would otherwise
// fall back to the US default), gets null and keeps being asked with no location at all, exactly as before.
export function probeCountry(site) {
  const hasExplicit = Array.isArray(site?.target_markets) && site.target_markets.length;
  if (!hasExplicit && !(site?.target_scope === 'local' && site?.country_code)) return null;
  const codes = [...new Set(resolveSiteLocations(site).map((l) => Number(l.locationCode)))];
  if (codes.length !== 1) return null;
  const iso = LOCATION_ISO[codes[0]];
  const name = LOCATION_NAMES[codes[0]];
  return iso && name ? { iso, name } : null;
}

// The markets a site actually sells into, as readable names — empty for a site
// with no market configuration (nothing to say, so callers add no market text).
export function targetMarketNames(site) {
  const hasExplicit = Array.isArray(site?.target_markets) && site.target_markets.length;
  if (!hasExplicit && site?.target_scope !== 'global' && site?.target_scope !== 'hybrid') return [];
  const names = resolveSiteLocations(site).map((l) => LOCATION_NAMES[l.locationCode]).filter(Boolean);
  return [...new Set(names)];
}
