import { listAllCompetitorDomains } from '../../store/competitor-profiles.js';

// The single, reusable "is this URL a configured competitor for THIS site"
// answer — every generator that can produce an outbound link (blog-outline,
// expand-content's Tavily-backed external-citations, and any future one)
// calls into this instead of re-deriving its own domain-matching logic.
// Tenant-scoped end to end: every export takes siteId explicitly, every
// cache key includes it, and a site with no competitor data (or a lookup
// failure) fails OPEN to an empty set — never falls back to another
// tenant's data, and never blocks content generation over an infra hiccup.

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // siteId -> { domains: Set<string>, expiresAt }

// Test-only: forces the next getCompetitorDomainSet call for every siteId to
// re-hit the DB, so tests that write competitor_profiles rows and then
// immediately assert on them don't see a stale/empty cache from an earlier
// test in the same process.
export function _clearCompetitorPolicyCache() {
  cache.clear();
}

// Same protocol/www/trailing-slash/lowercase normalization as
// site-domain.js's hostnameOf, applied to an arbitrary external URL or bare
// domain rather than just this site's own configured domain — kept as its
// own small function here (not imported from site-domain.js) since the two
// solve different problems: site-domain.js resolves THIS site's own
// domain, this resolves an arbitrary link's host for comparison against a
// competitor set.
export function normalizeHost(urlOrDomain) {
  if (!urlOrDomain) return null;
  const raw = String(urlOrDomain).trim();
  if (!raw) return null;
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  return host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || null;
}

// Loads THIS site's active (excluded_reason IS NULL) competitor domains,
// normalized, as a Set — cached per siteId for CACHE_TTL_MS. Deliberately
// reads across EVERY discovery run ever (listAllCompetitorDomains), not
// just the most recent one — see that function's comment for why a
// protection guard needs broader recall than a leaderboard display does. A
// DB error or a site with no competitor_profiles rows both resolve to an
// empty Set, which means "nothing gets blocked" (fail open on infra
// failure / missing config) rather than "generation is blocked" or, worse,
// silently reusing whatever the last-looked-up site's domains were.
export async function getCompetitorDomainSet(siteId) {
  if (!siteId) return new Set();
  const hit = cache.get(siteId);
  if (hit && hit.expiresAt > Date.now()) return hit.domains;

  let rows = [];
  try {
    rows = await listAllCompetitorDomains(siteId);
  } catch (err) {
    console.error(`[competitor-policy] failed to load competitor_profiles for site ${siteId}:`, err.message);
    rows = [];
  }
  const domains = new Set(
    rows
      .filter((r) => r.excluded_reason == null)
      .map((r) => normalizeHost(r.domain))
      .filter(Boolean)
  );
  cache.set(siteId, { domains, expiresAt: Date.now() + CACHE_TTL_MS });
  return domains;
}

// Exact-host or subdomain-of-a-configured-domain match — a competitor is
// still that competitor on a regional/product subdomain (e.g. a configured
// `f1soft.com` also blocks `blog.f1soft.com`), but a configured
// `np.linkedin.com` (a specific subdomain row) does NOT block bare
// `linkedin.com` or an unrelated `linkedin.com` page — only what was
// actually configured, and any subdomain of it.
export async function isCompetitorUrl(url, siteId) {
  const host = normalizeHost(url);
  if (!host) return false;
  const domains = await getCompetitorDomainSet(siteId);
  if (!domains.size) return false;
  for (const domain of domains) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

// Generators whose output is freeform LLM prose that can reference
// companies "from general knowledge" (blog-outline's SYSTEM_GENERAL,
// expand-content's SYSTEM_GENERAL/SYSTEM_COMPARISON) — the only two shapes
// that produced or could plausibly produce an unprompted competitor mention
// (external-citations is handled separately, by pre-filtering the Tavily
// candidate list itself in expand-content.js, not by prompt grounding,
// since a citation section only ever cites from an explicit candidate list).
export const COMPETITOR_CONTEXT_GENERATOR_IDS = new Set(['blog-outline', 'expand-content']);

// The prompt-level half of the policy — mirrors design-drift.js's
// withDesignContext exactly (same signature shape, same "append a grounding
// block to the system prompt, fail open on any error/empty-data" contract),
// wired into server/llm.js's callLLM alongside it. NOT the enforcement
// mechanism by itself — a model can still ignore an instruction, which is
// why findCompetitorLinks (outbound-link-guard.js) exists as the
// deterministic backstop. This only makes the model less likely to try in
// the first place, and gives it the real domains to avoid instead of a
// vague "don't mention competitors" that could be interpreted as
// forbidding an intentional, explicit comparison.
export async function withCompetitorContext(system, generatorId, siteId) {
  if (!generatorId || !siteId || !COMPETITOR_CONTEXT_GENERATOR_IDS.has(generatorId)) return system;
  const domains = await getCompetitorDomainSet(siteId);
  if (!domains.size) return system;

  return `${system}\n\nThis site's real, configured business competitors: ${[...domains].join(', ')}.\n` +
    'You MAY name these companies, compare their capabilities honestly, and describe their strengths and ' +
    'weaknesses — competitive comparison that establishes why this client is the better choice for the ' +
    'reader\'s use case is wanted content, not something to avoid. What you must not do is turn the ' +
    'client\'s own page into promotion for them:\n' +
    '- Never link to a competitor\'s site. A comparison makes its case without handing them a backlink.\n' +
    '- Never write a list, directory or roundup that profiles several competitors one after another.\n' +
    '- Keep the client the subject: the client\'s brand must appear in the title, H1 and meta description, ' +
    'and must be discussed at least as much as all competitors combined.\n' +
    '- Describe a competitor only as far as the comparison needs; do not write a flattering standalone ' +
    'profile of one, and always land on why the client is the better fit.';
}

// Splits a list of arbitrary items (e.g. Tavily search results, extracted
// outbound links) into { allowed, removed } based on whether each item's
// URL is a configured competitor for siteId. `urlKey` extracts the URL from
// an item — defaults to `item.url`. Used both by expand-content.js (filter
// Tavily candidates BEFORE they reach the model) and by the cross-tenant
// audit script (report which links are already live).
export async function filterCompetitorCandidates(items, siteId, urlKey = (item) => item.url) {
  const domains = await getCompetitorDomainSet(siteId);
  if (!domains.size) return { allowed: items, removed: [] };
  const allowed = [];
  const removed = [];
  for (const item of items) {
    const host = normalizeHost(urlKey(item));
    const isCompetitor = host && [...domains].some((d) => host === d || host.endsWith(`.${d}`));
    (isCompetitor ? removed : allowed).push(item);
  }
  return { allowed, removed };
}
