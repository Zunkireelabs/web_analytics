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

export async function resolveOwnDomain(site, siteId, start, end) {
  if (site.website_domain) return site.website_domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const topPages = await getSearchPerformanceRange(siteId, start, end, 'page', 1);
  return topPages[0] ? hostnameOf(topPages[0].dim_value) : null;
}
