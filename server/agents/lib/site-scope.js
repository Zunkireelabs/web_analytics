// Path scope: which URL paths on its domain belong to a site.
//
// One domain can host two SuperRank sites (zennly.io: a marketplace at / and the business site under /business) behind one
// Search Console property. Hostname filtering cannot tell them apart; this is the path-level counterpart of site-domain.js,
// applied at the same three places: ingestion (what is stored), the agents' page pools (what is worked on), and the
// implementers (what may be written). Pure of any database or network.
//
// Convention shared with site-domain.js: a site with no scope (both lists empty, the default for every existing site) is
// passed through unfiltered. Empty means "no path restriction", never "nothing is ours".

// '/business/', 'business', ' /Business?x=1 ' -> '/Business'. '/' and blanks mean nothing and are dropped. Case is kept: paths are
// case-sensitive on most hosts.
export function normalizePrefix(p) {
  const raw = String(p ?? '').trim().split(/[?#]/)[0];
  if (!raw) return null;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const trimmed = withSlash.replace(/\/+$/, '');
  return trimmed && trimmed !== '/' ? trimmed : null;
}

const prefixes = (list) => [...new Set((Array.isArray(list) ? list : []).map(normalizePrefix).filter(Boolean))];

export function scopeOf(site) {
  return { include: prefixes(site?.scope_include_paths), exclude: prefixes(site?.scope_exclude_paths) };
}

// Identity of a scope, equal to the trigger-maintained sites.scope_key (migration 262). Unscoped is '|'.
export function scopeKey(site) {
  const { include, exclude } = scopeOf(site);
  return `${[...include].sort().join(',')}|${[...exclude].sort().join(',')}`;
}

export function hasScope(site) {
  const s = scopeOf(site);
  return s.include.length > 0 || s.exclude.length > 0;
}

// The path of a full URL, or of a bare path. Null when nothing path-like can be read from it.
export function pathOf(urlOrPath) {
  const s = String(urlOrPath ?? '').trim();
  if (!s) return null;
  try { return new URL(s).pathname || '/'; } catch { /* a bare path */ }
  return s.startsWith('/') ? s.split(/[?#]/)[0] : null;
}

const matches = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

export function pathInScope(site, path) {
  const { include, exclude } = scopeOf(site);
  if (!include.length && !exclude.length) return true;
  if (typeof path !== 'string' || !path) return true; // nothing readable to judge: same pass-through rule as an unset domain
  if (exclude.some((p) => matches(path, p))) return false;
  return include.length === 0 || include.some((p) => matches(path, p));
}

export const urlInScope = (site, urlOrPath) => pathInScope(site, pathOf(urlOrPath));

// Drops rows whose URL is outside the site's scope. Same default accessor as filterOwnDomainPages.
export function filterByScope(rows, site, urlOf = (r) => r.dim_value ?? r.page ?? r) {
  if (!hasScope(site)) return rows;
  return rows.filter((row) => urlInScope(site, urlOf(row)));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Search Console page filters that apply the scope at the API request itself, like site-domain's host filter, so no consumer ever
// stores or sees an out-of-scope page. RE2-safe. Returns [] for an unscoped site.
export function scopePageFilters(site) {
  const { include, exclude } = scopeOf(site);
  const re = (list) => `^https?://[^/]+(${list.map(escapeRe).join('|')})([/?#]|$)`;
  const filters = [];
  if (include.length) filters.push({ dimension: 'page', operator: 'includingRegex', expression: re(include) });
  if (exclude.length) filters.push({ dimension: 'page', operator: 'excludingRegex', expression: re(exclude) });
  return filters;
}

// Links from this site to the other site on a shared domain are never invented. They are the explicit list in
// url_file_map.crossSiteLinks = [{ url }] a person configured; only http(s) URLs are kept. An unconfigured site has none.
export function crossSiteLinkTargets(site) {
  const out = [];
  for (const e of Array.isArray(site?.url_file_map?.crossSiteLinks) ? site.url_file_map.crossSiteLinks : []) {
    const u = typeof e === 'string' ? e : e?.url;
    try { const url = new URL(u); if (/^https?:$/.test(url.protocol)) out.push(url.href); } catch { /* skipped */ }
  }
  return [...new Set(out)];
}

// A link target this site may use: inside its own path scope, or one of its configured cross-site targets.
export const linkTargetAllowed = (site, url) => urlInScope(site, url) || crossSiteLinkTargets(site).includes(url);

// GA4 Data API dimension filter that applies the scope to a report request (pagePath), so two sites sharing one GA4 property each
// read only their own paths. Same semantics as the other filters here: matched on a path-segment boundary, exclude wins. FULL_REGEXP is
// RE2. Returns null for an unscoped site.
export function ga4ScopeFilter(site) {
  const { include, exclude } = scopeOf(site);
  const re = (list) => `(${list.map(escapeRe).join('|')})(/.*)?`;
  const pathFilter = (list) => ({ filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: re(list), caseSensitive: true } } });
  const parts = [];
  if (include.length) parts.push(pathFilter(include));
  if (exclude.length) parts.push({ notExpression: pathFilter(exclude) });
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : { andGroup: { expressions: parts } };
}

// A report request with the site's scope ANDed into whatever filter it already carries.
export function withGa4Scope(request, site) {
  const scope = ga4ScopeFilter(site);
  if (!scope) return request;
  const existing = request.dimensionFilter;
  return { ...request, dimensionFilter: existing ? { andGroup: { expressions: [existing, scope] } } : scope };
}

// ── Sibling awareness ────────────────────────────────────────────────────────────────────────────────────────────────────────
// A scoped site shares its domain with another SuperRank site (zennly.io: marketplace at /, business under /business). The gates above
// STOP an agent crossing over; this tells it the other section exists, so it does not write content that competes with it, does not
// treat it as its own, and does not mistake its pages for gaps. Empty for an unscoped site, so every existing prompt is unchanged.
const list = (xs) => xs.join(', ');

// siblings: other site rows on the same domain, [{ name }] (optional; the scope alone is enough to word the note).
export function siblingSectionNote(site, siblings = []) {
  const { include, exclude } = scopeOf(site);
  if (!include.length && !exclude.length) return '';
  const host = site?.website_domain ? String(site.website_domain).replace(/^https?:\/\//, '').replace(/\/+$/, '') : 'this domain';
  const mine = include.length ? `only the ${list(include)} section of ${host}` : `${host} except ${list(exclude)}`;
  const theirs = exclude.length ? `${list(exclude)} on ${host}` : `everything on ${host} outside ${list(include)}`;
  const names = (Array.isArray(siblings) ? siblings : []).map((s) => s?.name).filter(Boolean);
  const who = names.length ? ` (the project "${names.join('", "')}")` : '';
  const links = crossSiteLinkTargets(site);
  return `This site is ${mine}. ${theirs[0].toUpperCase()}${theirs.slice(1)} is a different site${who} with its own audience, keywords, design and agent. ` +
    'Work only on this site: do not propose or write content that targets the other site\'s audience or competes for its topics, do not treat its pages as gaps here, ' +
    `and never edit its pages or files.${links.length ? ` You may link to it only at: ${list(links)}.` : ' Do not link to it unless a link is explicitly provided.'}`;
}
