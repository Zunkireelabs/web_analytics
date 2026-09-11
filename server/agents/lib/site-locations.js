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

  switch (site?.target_scope) {
    case 'local': return ownLocation ? [ownLocation] : [globalLocation];
    case 'hybrid': return ownLocation ? [ownLocation, globalLocation] : [globalLocation];
    default: return [globalLocation]; // 'global' (default), or no target_scope set at all
  }
}
