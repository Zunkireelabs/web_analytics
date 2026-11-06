// A canonical form for the page part of a recommendation's identity, so two detectors that name one page two slightly different
// ways (www or not, a #fragment, a tracking parameter, parameters in another order) land on ONE recommendation instead of two.
//
// THIS FILE ONLY COMPUTES. Nothing here reads or writes the database, and nothing in the app calls it yet: it is used by the
// read-only duplicate report (scripts/report-page-key-duplicates.js) so the rules can be reviewed against real data before any
// key is changed.
//
// THE RULES, each one independent so a report can say exactly which of them made two rows the same:
//
//   always (cannot change which page it is)
//     host-case      the host is lowercased (and a default port dropped) by the URL parser
//     fragment       #section is never part of which page was fetched
//     tracking       known tracking parameters are dropped (utm_*, gclid, fbclid, msclkid, ...)
//     query-order    the parameters that are left are sorted, so ?a=1&b=2 and ?b=2&a=1 match
//
//   only with evidence
//     www            "www." is removed only when the project's own domain says www and the bare host are the same site
//                    (`canonicalHost`). Without that evidence a www host is left alone. A live redirect check is a stronger
//                    proof and is the next step; the report labels every use of this rule as "by configuration".
//
//   never
//     path case      /About and /about are different pages on many servers, so the path is kept exactly as written
//     meaningful query parameters   ?page=2, ?id=7, ?lang=ne are kept: they usually select different content
//
//   optional, reported separately so a person decides (they CAN be different pages on some frameworks)
//     trailing-slash   /about/ vs /about
//     scheme           http:// vs https://
//
// A value that is not an absolute http(s) URL (a topic key, a file path, "analytics:ga4", "") is returned unchanged with
// `url: false`, so the caller can leave it alone.

export const TRACKING_PARAM = /^(utm_[a-z0-9_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|ttclid|igshid|mc_cid|mc_eid|_ga|_gl|li_fat_id)$/i;

const ABSOLUTE = /^https?:\/\//i;

// "https://www.Example.com/" -> "example.com": the project's domain as a bare host, or null.
export function bareHost(value) {
  if (!value) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(String(value)) ? String(value) : `https://${String(value)}`);
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch { return null; }
}

// Is `host` the project's own domain with or without a leading www? That is the whole www test.
export function isWwwAlias(host, canonicalHost) {
  const c = bareHost(canonicalHost);
  if (!c || !host) return false;
  const h = String(host).toLowerCase();
  return h === c || h === `www.${c}`;
}

// options.canonicalHost   the project's own domain (sites.website_domain), enabling the www rule
// options.trailingSlash   also treat /about/ and /about as one page (never the root "/")
// options.scheme          also treat http and https as one page
// Returns { url, key, changes } where `changes` lists the rules that altered the value.
export function canonicalizePage(raw, { canonicalHost = null, trailingSlash = false, scheme = false } = {}) {
  const value = String(raw ?? '').trim();
  if (!ABSOLUTE.test(value)) return { url: false, key: value, changes: [] };
  let u;
  try { u = new URL(value); } catch { return { url: false, key: value, changes: [] }; }

  const changes = [];
  const original = u.toString();
  const hostBefore = u.hostname;

  if (u.hash) { u.hash = ''; changes.push('fragment'); }

  // tracking parameters out, the rest kept and sorted
  const kept = [];
  let droppedTracking = false;
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PARAM.test(k)) droppedTracking = true; else kept.push([k, v]);
  }
  const sorted = [...kept].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)));
  const reordered = kept.some(([k, v], i) => k !== sorted[i][0] || v !== sorted[i][1]);
  if (droppedTracking) changes.push('tracking');
  if (reordered) changes.push('query-order');
  const search = sorted.length ? `?${sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
  // Rebuilt from the sorted list only when something changed, so an untouched query string is returned byte for byte.
  if (droppedTracking || reordered) u.search = search;

  if (u.hostname.startsWith('www.') && isWwwAlias(u.hostname, canonicalHost)) { u.hostname = u.hostname.slice(4); changes.push('www'); }

  if (trailingSlash && u.pathname.length > 1 && u.pathname.endsWith('/')) { u.pathname = u.pathname.replace(/\/+$/, '') || '/'; changes.push('trailing-slash'); }
  if (scheme && u.protocol === 'http:') { u.protocol = 'https:'; changes.push('scheme'); }

  // host-case is done by the parser; record it only when the written host differed from the parsed one
  const writtenHost = (/^https?:\/\/([^/?#]+)/i.exec(value)?.[1] || '').replace(/:\d+$/, '');
  if (writtenHost && writtenHost !== hostBefore) changes.push('host-case');

  const key = u.toString();
  return { url: true, key: key === original && !changes.length ? original : key, changes };
}

// A recommendation's `page` column is not always a bare URL: some fix types key on more than the page. The URL is the part that
// can be canonicalized; the rest must be kept exactly. Returns { prefix, url, suffix } or null when there is no URL to touch.
//   "https://x.com/a::focus"                -> expand-content        (page::focus)
//   "https://x.com/a::https://y.com/b"      -> broken-link-fix       (page::href)   [only the page part is touched]
//   "redirect::https://x.com/old"           -> redirect-add
//   "https://x.com/a::fixType::3::heading"  -> content-integrity-repair
// Keys with no page in them ("topic::...", "landing::...", "analytics:ga4", "blog-image::...", "") are not URL keys.
export function splitPageKey(pageKey) {
  const s = String(pageKey ?? '');
  if (s.startsWith('redirect::')) {
    const rest = s.slice('redirect::'.length);
    return ABSOLUTE.test(rest) ? { prefix: 'redirect::', url: rest, suffix: '' } : null;
  }
  if (!ABSOLUTE.test(s)) return null;
  const at = s.indexOf('::');
  return at === -1 ? { prefix: '', url: s, suffix: '' } : { prefix: '', url: s.slice(0, at), suffix: s.slice(at) };
}

export function canonicalPageKey(pageKey, options) {
  const parts = splitPageKey(pageKey);
  if (!parts) return { url: false, key: String(pageKey ?? ''), changes: [] };
  const c = canonicalizePage(parts.url, options);
  return { url: c.url, key: `${parts.prefix}${c.key}${parts.suffix}`, changes: c.changes };
}
