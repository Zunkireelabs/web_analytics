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

// The public origin a site's live pages are served from — the anchor for
// site-level checks (/llms.txt, /robots.txt, /sitemap.xml, the shared
// layout template) that have no per-page URL of their own. Returns null
// rather than guessing when a site has no domain configured, which callers
// (verificationMethodFor, generators' own verifyCurrentState) turn into an
// explicit 'unverifiable'/no-checkable-target answer instead of a
// fabricated check. Moved here (from routes/action-center.js, its original
// caller) so generators can reuse it without statically importing that
// route file's much heavier dependency graph.
export function siteOriginFor(site) {
  const raw = site?.website_domain || site?.gsc_property?.replace(/^sc-domain:/, '') || null;
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return null;
  }
}

export async function resolveOwnDomain(site, siteId, start, end) {
  const known = knownDomain(site);
  if (known) return known;
  const topPages = await getSearchPerformanceRange(siteId, start, end, 'page', 1);
  return topPages[0] ? hostnameOf(topPages[0].dim_value) : null;
}

// The full set of hostnames a site considers its own, for FILTERING
// purposes only (never for building an absolute URL — see
// additional_own_domains' migration comment for why that stays
// website_domain-only). A site can have more than one real hostname worth
// counting: a hero product launched on its own subdomain of the same root
// domain (e.g. a booking-engine product on zenly.<domain>, a CRM product
// on edgex.<domain>), alongside the main marketing site — distinct from an
// unrelated project on a different subdomain that should stay excluded.
// Returns null (same "pass through unfiltered" convention as knownDomain)
// when website_domain itself was never set, even if additional_own_domains
// somehow has entries — additional domains only ever narrow an existing
// primary-domain filter, never substitute for one.
export function ownDomains(site) {
  const primary = knownDomain(site);
  if (!primary) return null;
  const extra = (site?.additional_own_domains || [])
    .map((d) => String(d).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''))
    .filter(Boolean);
  return [primary, ...extra];
}

// Filters a list of real page rows/URLs down to the site's own domain(s) —
// a domain-level GSC property (sc-domain:...) returns EVERY subdomain
// Search Console has data for, which can include an entirely different
// product living on a subdomain of the same root domain. Without this,
// that other product's pages leak into recommendation/draft-generation
// candidate pools. `domain` is either a single hostname (knownDomain(site))
// or the fuller set (ownDomains(site)) — never `resolveOwnDomain()`'s
// guessed fallback, since a wrong guess (e.g. a foreign subdomain
// outranking the site's own pages) would filter OUT the site's real pages
// instead of the foreign ones. Falsy/empty `domain` passes everything
// through unfiltered rather than dropping all data over an unresolved guess.
export function filterOwnDomainPages(rows, domain, urlOf = (r) => r.dim_value ?? r.page ?? r) {
  if (!domain || (Array.isArray(domain) && domain.length === 0)) return rows;
  const allowed = new Set(Array.isArray(domain) ? domain : [domain]);
  return rows.filter((row) => allowed.has(hostnameOf(urlOf(row))));
}
