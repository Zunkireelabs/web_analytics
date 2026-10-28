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

export function findVisibleClaimIssues(content, generatorId, site) {
  const bans = visibleClaimBansFor(site);
  if (!bans.length || SEARCH_ONLY_GENERATOR_IDS.has(generatorId)) return { issues: [] };
  const res = bans.map((p) => [p, new RegExp(`(?<![\\w])${escapeRe(p).replace(/\s+/g, '\\s+')}(?![\\w])`, 'i')]);
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
