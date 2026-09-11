import { analyzePageUrl } from './page-content.js';
import { scorePageCategories } from './visibility-score.js';
import { getSearchPerformanceRange, getSiteById } from '../../store/read.js';
import { getCompetitorProvider, competitorProviderConfigured } from '../../ingest/competitor-providers/index.js';
import { callLLM } from '../../llm.js';
import { resolveOwnDomain, knownDomain, filterOwnDomainPages } from './site-domain.js';
import { resolveSiteLocations } from './site-locations.js';

// LLM-driven competitor discovery + crawl + compare — the MVP pipeline that
// makes competitor-intelligence work with zero external SEO API, so it's
// never blocked on DataForSEO/Ahrefs/Semrush credentials being configured
// (see agents/competitor-intelligence.js for how a real SERP provider, when
// configured, enriches this with live keyword rankings on top).

const MAX_COMPETITORS = 5;
const TOP_PAGES_FOR_CONTEXT = 8;
const TOP_QUERIES_FOR_CONTEXT = 15;
const SERP_QUERIES_TO_CHECK = 5;
const SERP_DEPTH_PER_QUERY = 10;

function stripJsonFences(raw) {
  return raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
}

// The same real, deterministic 5-category structural score ai-visibility.js
// already computes for this site's own pages (schema/structuredContent/faq/
// entities/citationReadiness — llmsReadiness excluded here since that's a
// site-level robots.txt/llms.txt check, not fair to run per competitor
// fetch) — applied to a competitor's homepage too, so "who's ahead" is a
// real, comparable, computed number instead of an LLM-narrated impression.
function overallStructuralScore(analysis) {
  const categories = scorePageCategories(analysis);
  const values = Object.values(categories);
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

// Only the structural signals page-content.js already computes for every
// other agent (ai-visibility/content-gap/opportunity) — the comparison
// below is grounded in the same real signals, not a second scoring system.
function summarizeAnalysis(a) {
  return {
    title: a.title, hasMetaDescription: a.hasMetaDescription, hasSchema: a.hasSchema, schemaTypes: a.schemaTypes,
    hasFaq: a.hasFaq, h1Count: a.h1Count, h2Count: a.h2Count, wordCount: a.wordCount,
    hasComparisonContent: a.hasComparisonContent, internalLinkCount: a.internalLinkCount,
  };
}

// Step 1, preferred path — who ACTUALLY ranks on Google for this site's own
// real top queries, via a real SERP provider (DataForSEO by default, see
// ingest/competitor-providers/). This is the literal, verifiable answer to
// "who's really out there" — unlike the LLM fallback below, which can only
// ever be a plausible guess from general training-data knowledge and has no
// way to know a hyper-local or small-market competitive landscape it was
// never trained on in detail. Domains are tallied by how many of the site's
// own queries they appear in, so a competitor that consistently shows up
// across multiple real searches ranks above one that appeared once.
async function detectCompetitorsFromSerp(ownDomain, topQueries, { locationCode, languageCode }) {
  const provider = getCompetitorProvider();
  const domainCounts = new Map();
  for (const query of topQueries.slice(0, SERP_QUERIES_TO_CHECK)) {
    let results;
    try {
      results = await provider.fetchRankings(query, { locationCode, languageCode });
    } catch {
      continue; // one query's failure (quota, no results) shouldn't abort discovery for the rest
    }
    for (const r of results.slice(0, SERP_DEPTH_PER_QUERY)) {
      if (!r.domain || r.domain === ownDomain) continue;
      domainCounts.set(r.domain, (domainCounts.get(r.domain) || 0) + 1);
    }
  }
  return [...domainCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_COMPETITORS).map(([domain]) => domain);
}

// Step 1, fallback path — ask an LLM to name real, plausible competitor
// domains from the site's own top pages and queries. No external API
// required, unlike the real SERP path above, but also no way to verify
// against what's actually ranking today — only used when no real SERP
// provider is configured (see runCompetitorDiscovery). The LLM can name a
// domain that doesn't actually exist or isn't reachable — step 2 (crawl)
// drops those: a fake/unreachable domain simply fails to fetch, never
// trusted on the LLM's say-so alone.
//
// But reachability is ALL it proves. A real, operating, entirely irrelevant
// company fetches fine, so a domain that arrives here with discoverySource
// 'llm' is model recall and nothing more — it is never "computed". Two
// things keep that honest downstream and neither of them needs a paid API:
// analyzeCompetitor attaches queryOverlap (a real, free relevance number
// measured against this site's own Search Console queries — see
// queryRelevanceOverlap), and competitor-intelligence.js labels the finding
// with how the domain was actually found and refuses to rank an
// unverified, zero-overlap candidate alongside a SERP-confirmed one.
export async function detectCompetitors(ownDomain, topPages, topQueries, businessContext = {}) {
  const { title, metaDescription } = businessContext;
  const system = 'You are a market-research analyst identifying REAL business competitors for a company — not an ' +
    'SEO keyword-overlap tool. Using what the company\'s own homepage says about itself (its actual industry, ' +
    'services, and target market/geography), name 3-5 REAL, well-known companies a prospective customer would ' +
    'genuinely consider as alternatives — companies competing in the same market and, where the business is ' +
    'clearly local/regional, the same geography. Do not just name websites that happen to rank for similar search ' +
    'terms; a true market competitor may not share any keywords at all. Also weigh which of those companies has ' +
    'real visibility in AI answer engines (ChatGPT, Perplexity, Google AI Overviews) for this industry, since that ' +
    'reflects current competitive standing. Only name a domain you have specific, genuine knowledge of as a real, ' +
    'operating company — never invent a plausible-sounding domain or guess a company into existence because its ' +
    'name would fit the pattern. If you are not confident about a 4th or 5th real competitor, return fewer than 5 ' +
    'rather than padding the list with a guess. Respond with ONLY a JSON array of bare domains (no protocol, no ' +
    'www), e.g. ["example.com","other.com"]. Never include the site\'s own domain.';
  const context = [
    `Own domain: ${ownDomain}`,
    title ? `Homepage title: ${title}` : null,
    metaDescription ? `Homepage description: ${metaDescription}` : null,
    `Top pages: ${topPages.join(', ') || 'none'}`,
    `Top queries: ${topQueries.join(', ') || 'none'}`,
  ].filter(Boolean).join('\n');
  // 'monthly' tier — a stronger model than the cheap daily-narrative default,
  // since real-world knowledge of specific/local companies (not just
  // pattern-matching keywords) is exactly what a bigger model does better,
  // and this only runs once a week per site.
  const raw = await callLLM(system, context, { maxTokens: 250, tier: 'monthly' }).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((d) => String(d).trim().toLowerCase().replace(/^www\./, '')))]
      .filter((d) => d && d !== ownDomain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
      .slice(0, MAX_COMPETITORS);
  } catch {
    return [];
  }
}

// Same normalization + allowlist regex already applied inline to LLM-returned
// domains above (lowercase, strip www, must look like a real domain) —
// factored out so agentic-orchestrator.js can apply the identical sanitizing
// to a model-supplied params.competitor value before it's ever used to build
// a URL or trusted downstream.
export function normalizeCompetitorDomain(raw) {
  if (!raw) return null;
  const d = String(raw).trim().toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

// A small, generic, tenant-agnostic list of universal social/search/
// developer/video platforms — not a business's real competitor, just a
// domain that shows up in SERP results or LLM recall because it's a
// platform everyone links to (a company's own Facebook page, a GitHub org,
// a LinkedIn post about the industry). This is deliberately NOT a
// per-client exclusion list: it applies identically to every tenant, the
// same way excluding a site's own domain already does, and it never
// contains a real operating company that could legitimately be someone's
// competitor. Kept intentionally short — when in doubt, a domain is left
// classified as a real competitor rather than guessed into this list; see
// competitor_profiles.excluded_reason (migration 133) for how this is
// persisted, and competitor-policy.js for how it's consumed.
const KNOWN_PLATFORM_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com',
  'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com',
  'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com',
  'wikipedia.org', 'medium.com', 'amazon.com', 'apple.com', 'microsoft.com',
]);

// Matches the exact domain OR a subdomain of it (e.g. np.linkedin.com,
// support.google.com) — a platform is still a platform on a regional or
// product subdomain.
export function isKnownPlatformDomain(domain) {
  const d = normalizeCompetitorDomain(domain);
  if (!d) return false;
  for (const platform of KNOWN_PLATFORM_DOMAINS) {
    if (d === platform || d.endsWith(`.${platform}`)) return true;
  }
  return false;
}

// Words that carry no topical signal, so a query made only of these can't
// tell us anything about whether a candidate is really in the same market.
const RELEVANCE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'near', 'best', 'top', 'how', 'what', 'who', 'why', 'when', 'where',
  'you', 'your', 'our', 'are', 'from', 'that', 'this', 'about', 'into', 'www', 'com',
]);

// Free, deterministic relevance grounding for a candidate nobody verified
// against a real SERP. Without a SERP provider configured — the default for
// any tenant that isn't paying for DataForSEO — competitor discovery is
// purely an LLM recalling well-known companies from training data, and the
// ONLY filter it then passed through was "the homepage fetched successfully".
// A real, operating, completely irrelevant company clears that bar easily and
// then gets presented to a customer as an identified competitor. This asks a
// question that can be answered from data we already have, for free: does
// this candidate's own homepage actually talk about the things this site's
// real Search Console searchers are searching for? A query counts as matched
// only when every one of its topical terms is literally present in the
// candidate's fetched homepage text — never a similarity guess.
//
// Brand terms (the site's own domain label) are dropped from each query
// before testing: a competitor's homepage will never contain this site's own
// brand name, so leaving those in would score every genuine competitor zero.
// A query left with no topical terms at all (a pure brand search) is not
// counted as checked either — it's an unanswerable test, not a failed one,
// and `queriesChecked: 0` is how the caller knows the overlap number carries
// no information rather than being real evidence of irrelevance.
export function queryRelevanceOverlap(analysis, topQueries, ownDomain) {
  const haystack = `${analysis.title || ''} ${analysis.metaDescription || ''} ${analysis.bodyText || ''}`.toLowerCase();
  const brandTerms = new Set(String(ownDomain || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const matched = [];
  let queriesChecked = 0;
  for (const q of topQueries) {
    const terms = String(q).toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !RELEVANCE_STOPWORDS.has(t) && !brandTerms.has(t));
    if (!terms.length) continue;
    queriesChecked++;
    if (terms.every((t) => haystack.includes(t))) matched.push(q);
  }
  return { queriesChecked, overlapCount: matched.length, matchedQueries: matched.slice(0, 5) };
}

// Step 2 (crawl) + 3 (compare) — fetch one candidate's real homepage and, if
// it resolves, ask an LLM to compare it against the site's own already-
// fetched analysis using only the real structural signals given.
export async function analyzeCompetitor(domain, ownAnalysis, ownDomain, ownScore, topQueries = []) {
  const fetched = await analyzePageUrl(`https://${domain}`);
  if (!fetched.ok) return { domain, ok: false, error: fetched.error };
  const competitorScore = overallStructuralScore(fetched.analysis);
  // Persisted alongside the LLM's narrative comparison so content-gap.js can
  // later ask "how many tracked competitors actually have FAQ/schema/
  // comparison content" as a real aggregate, not just this one homepage's
  // LLM-narrated verdict — see content-gap.js's competitive-gap framing.
  const structuralSignals = {
    hasFaq: fetched.analysis.hasFaq,
    hasSchema: fetched.analysis.hasSchema,
    hasComparisonContent: fetched.analysis.hasComparisonContent,
  };
  // Real, free relevance evidence about THIS candidate — see
  // queryRelevanceOverlap above. Returned as its own top-level field, never
  // folded into `comparison` below, precisely because it is a computed number
  // and everything in `comparison` (apart from structuralSignals) is not.
  const queryOverlap = queryRelevanceOverlap(fetched.analysis, topQueries, ownDomain);

  // Earlier version had the model refer to the two sites as "Site A"/"Site B"
  // in its own output text — those placeholder labels then got stored
  // verbatim in evidence/whyItMatters (meaningless to a reader with no
  // legend) and, worse, had to be re-guessed by the separate downstream
  // synthesis narrative call (competitor-intelligence.js's run()), which
  // got the mapping backwards at least once — attributing the competitor's
  // real content depth to this site and vice versa. Forcing the model to
  // always name the real domains removes the ambiguity at the source,
  // instead of downstream code (or another LLM call) trying to resolve it.
  const system = `You are an SEO/content strategist comparing two real websites, ${ownDomain} (this site) and ` +
    `${domain} (the competitor), using ONLY the structural signals given (title, meta description, schema types ` +
    'present, FAQ presence, heading counts, word count, comparison content, internal link count) — never invent ' +
    `facts about either site beyond these signals. Always refer to each site by its real domain name (` +
    `"${ownDomain}" / "${domain}") — never as "Site A"/"Site B" or any other placeholder. Respond with ONLY a ` +
    'JSON object: {"positioning": "...", "contentDepth": "...", "seoStructure": "...", "aiVisibility": "...", ' +
    `"verdict": "..."} — each 1-2 sentences naming the real signal difference (e.g. "${ownDomain} has FAQ schema, ` +
    `${domain} does not"); "verdict" is one sentence on the single most actionable gap.`;
  const user = `${ownDomain} (this site): ${JSON.stringify(summarizeAnalysis(ownAnalysis))}\n` +
    `${domain} (the competitor): ${JSON.stringify(summarizeAnalysis(fetched.analysis))}`;
  const raw = await callLLM(system, user, { maxTokens: 500 }).catch(() => null);
  if (!raw) return { domain, ok: false, error: 'comparison LLM call failed' };
  try {
    const comparison = JSON.parse(stripJsonFences(raw));
    // WARNING for every consumer: apart from `structuralSignals` (real
    // booleans computed from the fetched HTML, which content-gap.js
    // aggregates), every field of `comparison` — positioning, contentDepth,
    // seoStructure, aiVisibility, verdict — is free-text LLM commentary.
    // competitor-intelligence.js used to spread this whole object straight
    // into a Finding's `evidence`, which types.js reserves for "the specific
    // real numbers backing this finding, never a re-statement or a new
    // invented number" — so a paragraph of model prose was being shown to a
    // customer as computed evidence. It belongs in facts/narrative, never in
    // evidence; the real numbers a Finding may cite are ownScore,
    // competitorScore, structuralSignals and queryOverlap.
    return { domain, ok: true, comparison: { ...comparison, structuralSignals }, queryOverlap, ownScore, competitorScore };
  } catch {
    return { domain, ok: false, error: 'comparison response was not valid JSON' };
  }
}

// Full pipeline: detect -> crawl -> compare. Returns every candidate,
// successful or not, so a caller can report "identified but couldn't reach
// X" instead of a competitor silently vanishing.
export async function runCompetitorDiscovery(siteId, start, end, { forceDomain } = {}) {
  const [site, topPagesRaw, topQueries] = await Promise.all([
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', TOP_PAGES_FOR_CONTEXT),
    getSearchPerformanceRange(siteId, start, end, 'query', TOP_QUERIES_FOR_CONTEXT),
  ]);
  const ownDomain = await resolveOwnDomain(site, siteId, start, end);
  // knownDomain (primary domain only), not ownDomains — see candidate-pages.js's
  // own comment on this same 2026-08-24 fix.
  const topPageUrls = filterOwnDomainPages(topPagesRaw, knownDomain(site)).map((p) => p.dim_value);
  if (!topPageUrls.length) return { ownDomain, competitors: [] };

  const ownPageFetch = await analyzePageUrl(topPageUrls[0]);
  if (!ownPageFetch.ok) return { ownDomain, ownScore: null, competitors: [] };
  const ownScore = overallStructuralScore(ownPageFetch.analysis);

  const queryTexts = topQueries.map((q) => q.dim_value);
  // This site's own real target market (see migration 159) rather than one
  // global default for every tenant.
  const { locationCode, languageCode } = resolveSiteLocations(site)[0];
  const businessContext = { title: ownPageFetch.analysis.title, metaDescription: ownPageFetch.analysis.metaDescription };

  // Two independent discovery lenses, run together rather than as a
  // fallback chain: the LLM reasons about the real marketplace/industry
  // (a true competitor may share zero keywords with this site), while a
  // real SERP provider (when configured) reports who genuinely ranks on
  // Google for this site's own queries — a keyword-overlap signal the LLM
  // can't verify on its own. Merging both catches more of the real
  // competitive landscape than either alone; a domain both lenses agree on
  // is the strongest signal available.
  const [serpDomains, llmDomains] = await Promise.all([
    competitorProviderConfigured()
      ? detectCompetitorsFromSerp(ownDomain, queryTexts, { locationCode, languageCode }).catch(() => [])
      : Promise.resolve([]),
    detectCompetitors(ownDomain, topPageUrls, queryTexts, businessContext).catch(() => []),
  ]);

  const sourceByDomain = new Map();
  for (const d of serpDomains) sourceByDomain.set(d, 'serp');
  for (const d of llmDomains) sourceByDomain.set(d, sourceByDomain.has(d) ? 'both' : 'llm');

  // 'both' (agreed by real rankings and market knowledge) ranks highest,
  // then verified SERP-only, then market-knowledge-only — so the cap below
  // keeps the most-confirmed candidates first when the combined list is
  // larger than MAX_COMPETITORS.
  const CONFIDENCE_RANK = { both: 0, serp: 1, llm: 2 };
  const discoveredDomains = [...sourceByDomain.keys()]
    .sort((a, b) => CONFIDENCE_RANK[sourceByDomain.get(a)] - CONFIDENCE_RANK[sourceByDomain.get(b)])
    .slice(0, MAX_COMPETITORS);

  // A caller-forced domain (e.g. the agentic loop's params.competitor) always
  // gets analyzed even if discovery didn't surface it — unshifted ahead of
  // the cap rather than added on top of it, so this never exceeds
  // MAX_COMPETITORS worth of real analysis calls.
  const candidateDomains = forceDomain && forceDomain !== ownDomain
    ? [forceDomain, ...discoveredDomains.filter((d) => d !== forceDomain)].slice(0, MAX_COMPETITORS)
    : discoveredDomains;

  const competitors = await Promise.all(candidateDomains.map((d) =>
    analyzeCompetitor(d, ownPageFetch.analysis, ownDomain, ownScore, queryTexts)
      .then((c) => ({ ...c, discoverySource: sourceByDomain.get(d) || 'forced' }))
  ));

  return { ownDomain, ownScore, competitors };
}
