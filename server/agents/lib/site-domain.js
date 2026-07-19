import { getSearchPerformanceRange } from '../../store/read.js';

// Shared "what is this site's own real domain" resolution — used by any
// agent that needs to call an external API keyed by domain (authority.js's
// DataForSEO backlink lookup, ai-recommendation.js's mention-matching).
// Prefers the site's own explicitly-set website_domain (human-confirmed at
// onboarding) over guessing; falls back to deriving a hostname from the
// site's own top real GSC page — never fabricated, and null (handled by
// each caller as insufficient-data) when neither exists yet.
export function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// Explicit-only — never guesses. Safe to use for filtering: an unset
// website_domain returns null (callers pass everything through unfiltered,
// see filterOwnDomainPages) rather than risk excluding a site's own real
// pages on a wrong guess.
export function knownDomain(site) {
  if (!site?.website_domain) return null;
  return site.website_domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

export async function resolveOwnDomain(site, siteId, start, end) {
  const known = knownDomain(site);
  if (known) return known;
  const topPages = await getSearchPerformanceRange(siteId, start, end, 'page', 1);
  return topPages[0] ? hostnameOf(topPages[0].dim_value) : null;
}

// Filters a list of real page rows/URLs down to the site's own domain — a
// domain-level GSC property (sc-domain:...) returns EVERY subdomain Search
// Console has data for, which can include an entirely different product
// living on a subdomain of the same root domain. Without this, that other
// product's pages leak into recommendation/draft-generation candidate
// pools. Pass `knownDomain(site)` here, NOT `resolveOwnDomain()`'s guessed
// fallback — a wrong guess (e.g. a foreign subdomain outranking the site's
// own pages) would filter OUT the site's real pages instead of the foreign
// ones. `domain` null (no website_domain configured yet) passes everything
// through unfiltered rather than dropping all data over an unresolved guess.
export function filterOwnDomainPages(rows, domain, urlOf = (r) => r.dim_value ?? r.page ?? r) {
  if (!domain) return rows;
  return rows.filter((row) => hostnameOf(urlOf(row)) === domain);
}
