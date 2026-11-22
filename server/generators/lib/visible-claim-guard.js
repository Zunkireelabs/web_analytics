// Per-site "do not say this on the page" rule. Some tenants (e.g. a study-abroad
// consultancy whose university partners don't want to be shown endorsing a
// superlative) want a phrase like "best consultancy" absent from every
// VISIBLE page body but still free to appear in what search engines read: the
// <title>, meta description, Open Graph and structured data.
//
// Configured per site, never global — url_file_map.siteRoot.visibleClaimBans:
// an array of plain phrases, matched case-insensitively on word boundaries.
// A site with no list is unaffected (this returns no issues).
//
// The other half, url_file_map.siteRoot.searchClaims, is the phrases the
// business WANTS to be found for in search; meta-title.js offers them to the
// model for the title tag and meta description only.
//
// SEARCH-ONLY content is exempt by design: whole generators whose output is
// never rendered as page copy, and the metaTitle/metaDescription/og*/schema
// fields of generators that emit both. FAQ/Q&A JSON-LD is built from the same
// visible items by marker-merge, so those items ARE checked.
const SEARCH_ONLY_GENERATOR_IDS = new Set([
  'meta-title', 'open-graph', 'schema', 'schema-repair', 'llms-txt', 'canonical',
  'sitemap', 'robots-fix', 'breadcrumbs',
]);

const SEARCH_ONLY_KEYS = new Set([
  'metatitle', 'metadescription', 'titles', 'ogtitle', 'ogdescription',
  'seotitle', 'seodescription', 'schema', 'jsonld', 'structureddata',
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function visibleClaimBansFor(site) {
  const list = site?.url_file_map?.siteRoot?.visibleClaimBans;
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : [];
}

// Generators a site's ban list does NOT apply to, e.g. ['blog-outline'] for a tenant that may use a phrase in blog posts but never on the
// pages a visitor lands on first. Per site, never global: a site with no list is checked everywhere, exactly as before.
export function visibleClaimBansExemptGeneratorsFor(site) {
  const list = site?.url_file_map?.siteRoot?.visibleClaimBansExemptGenerators;
  return Array.isArray(list) ? list.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim()) : [];
}

// Words a site never wants in a TITLE TAG or META DESCRIPTION either (url_file_map.siteRoot.titleClaimBans). Separate from visibleClaimBans,
// which deliberately leaves the search-only fields alone. meta-title.js applies it to every page except article-like ones (blog posts).
export function titleClaimBansFor(site) {
  const list = site?.url_file_map?.siteRoot?.titleClaimBans;
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : [];
}

// Spaces in a phrase also match a hyphen ("study abroad partner" catches "study-abroad partner").
const phraseRe = (p) => new RegExp(`(?<![\\w])${escapeRe(p).replace(/\s+/g, '[\\s-]+')}(?![\\w])`, 'i');

export function findBannedPhrases(text, bans) {
  const t = String(text ?? '');
  return (bans || []).filter((p) => phraseRe(p).test(t));
}

// url_file_map.siteRoot.neverSayPhrases: exact phrases the client does not want on its general pages (e.g. "study abroad partner in Nepal":
// "study abroad partner" and "Nepal" are each fine alone). It covers title tags, meta descriptions, structured data and page copy, but NOT:
//   - blog posts / articles (decided from the page's classification, as for visibleClaimBans), and
//   - pages whose URL contains one of siteRoot.neverSayExemptUrlContains (e.g. ["nepal"] for the pages that are about Nepal).
// Unknown page type = strict (the ban stays on). A site with no list is unaffected.
export function neverSayPhrasesFor(site, { isArticlePage = false, pageUrl = null } = {}) {
  const root = site?.url_file_map?.siteRoot;
  const list = Array.isArray(root?.neverSayPhrases) ? root.neverSayPhrases.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : [];
  if (!list.length || isArticlePage) return [];
  const ex = Array.isArray(root?.neverSayExemptUrlContains) ? root.neverSayExemptUrlContains.filter((x) => typeof x === 'string' && x.trim()) : [];
  const u = String(pageUrl || '').toLowerCase();
  if (u && ex.some((x) => u.includes(x.trim().toLowerCase()))) return [];
  return list;
}

function allStrings(value, path = '') {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => allStrings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => allStrings(v, path ? `${path}.${k}` : k));
  return [];
}

export function findNeverSayIssues(content, site, ctx = {}) {
  const bans = neverSayPhrasesFor(site, ctx);
  if (!bans.length) return { issues: [] };
  const issues = [];
  // `previous` is what the page says today, kept on a draft so a change can be undone: not new copy, and it is exactly the text being replaced.
  const fresh = content && typeof content === 'object' && !Array.isArray(content) ? Object.fromEntries(Object.entries(content).filter(([k]) => k !== 'previous')) : content;
  for (const [path, text] of allStrings(fresh)) {
    for (const phrase of findBannedPhrases(text, bans)) {
      issues.push({
        path, patternId: 'never-say-phrase', snippet: phrase,
        correction: `Never write the exact phrase "${phrase}" on this page (body, headings, title, meta description, schema). Each word may appear on its own; only this combination is not allowed here. Rephrase, for example "study abroad partner" without the location.`,
      });
    }
  }
  return { issues };
}

export function searchClaimsFor(site) {
  const list = site?.url_file_map?.siteRoot?.searchClaims;
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : [];
}

function visibleStrings(value, path = '') {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => visibleStrings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => (
      SEARCH_ONLY_KEYS.has(k.toLowerCase()) ? [] : visibleStrings(v, path ? `${path}.${k}` : k)
    ));
  }
  return [];
}

export function findVisibleClaimIssues(content, generatorId, site, { isArticlePage = false } = {}) {
  const bans = visibleClaimBansFor(site);
  if (!bans.length || SEARCH_ONLY_GENERATOR_IDS.has(generatorId)) return { issues: [] };
  if (visibleClaimBansExemptGeneratorsFor(site).includes(generatorId)) return { issues: [] };
  // The page being edited is itself a blog post / article: the ban is for the pages a visitor lands on first, not for blog copy. Decided
  // from the page (quality-gate.js passes it), so it holds for EVERY generator, not just the blog generator.
  if (isArticlePage && site?.url_file_map?.siteRoot?.visibleClaimBansExemptArticlePages === true) return { issues: [] };
  const res = bans.map((p) => [p, phraseRe(p)]);
  const issues = [];
  for (const [path, text] of visibleStrings(content)) {
    for (const [phrase, re] of res) {
      if (!re.test(text)) continue;
      issues.push({
        path, patternId: 'banned-visible-claim', snippet: phrase,
        correction: `Do not use "${phrase}" anywhere in the visible page copy for this site. Describe what the business actually offers in plain, factual terms instead. (The phrase is allowed only in the title tag, meta description and structured data, which are written separately.)`,
      });
    }
  }
  return { issues };
}
