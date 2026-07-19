import { analyzePageUrl } from './page-content.js';
import { scorePageCategories } from './visibility-score.js';
import { getSearchPerformanceRange, getSiteById } from '../../store/read.js';
import { getCompetitorProvider } from '../../ingest/competitor-providers/index.js';
import { callLLM } from '../../llm.js';
import { resolveOwnDomain, knownDomain, filterOwnDomainPages } from './site-domain.js';

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
// domain that doesn't actually exist or isn't reachable — step 2 (crawl) is
// the real filter: a fake/unreachable domain simply fails to fetch and gets
// dropped, never trusted on the LLM's say-so alone.
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

// Step 2 (crawl) + 3 (compare) — fetch one candidate's real homepage and, if
// it resolves, ask an LLM to compare it against the site's own already-
// fetched analysis using only the real structural signals given.
export async function analyzeCompetitor(domain, ownAnalysis, ownDomain, ownScore) {
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
    return { domain, ok: true, comparison: { ...comparison, structuralSignals }, ownScore, competitorScore };
  } catch {
    return { domain, ok: false, error: 'comparison response was not valid JSON' };
  }
}

// Full pipeline: detect -> crawl -> compare. Returns every candidate,
// successful or not, so a caller can report "identified but couldn't reach
// X" instead of a competitor silently vanishing.
export async function runCompetitorDiscovery(siteId, start, end) {
  const [site, topPagesRaw, topQueries] = await Promise.all([
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', TOP_PAGES_FOR_CONTEXT),
    getSearchPerformanceRange(siteId, start, end, 'query', TOP_QUERIES_FOR_CONTEXT),
  ]);
  const ownDomain = await resolveOwnDomain(site, siteId, start, end);
  const topPageUrls = filterOwnDomainPages(topPagesRaw, knownDomain(site)).map((p) => p.dim_value);
  if (!topPageUrls.length) return { ownDomain, competitors: [] };

  const ownPageFetch = await analyzePageUrl(topPageUrls[0]);
  if (!ownPageFetch.ok) return { ownDomain, ownScore: null, competitors: [] };
  const ownScore = overallStructuralScore(ownPageFetch.analysis);

  const queryTexts = topQueries.map((q) => q.dim_value);
  const locationCode = Number(process.env.COMPETITOR_LOCATION_CODE || 2840);
  const languageCode = process.env.COMPETITOR_LANGUAGE_CODE || 'en';
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
    (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)
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
  const candidateDomains = [...sourceByDomain.keys()]
    .sort((a, b) => CONFIDENCE_RANK[sourceByDomain.get(a)] - CONFIDENCE_RANK[sourceByDomain.get(b)])
    .slice(0, MAX_COMPETITORS);

  const competitors = await Promise.all(candidateDomains.map((d) =>
    analyzeCompetitor(d, ownPageFetch.analysis, ownDomain, ownScore)
      .then((c) => ({ ...c, discoverySource: sourceByDomain.get(d) }))
  ));

  return { ownDomain, ownScore, competitors };
}
