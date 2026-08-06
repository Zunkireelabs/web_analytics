// Resolves a draft to a real file path in the site's repo using the explicit,
// human-populated `sites.url_file_map` config (see migration 028) — this
// module NEVER guesses a path from framework conventions. If nothing in the
// map matches, callers must treat that as an honest "not configured yet"
// failure (reason: 'no-file-mapping'), not attempt a fallback guess.

// Shared by every resolver below — normalizes a page URL to its pathname
// (with/without a trailing slash) and looks up the matching `pages` entry,
// so path-normalization logic exists exactly once.
function getPageEntry(site, pageUrl) {
  const map = site.url_file_map || {};
  if (!pageUrl) return null;
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return map.pages?.[path] || map.pages?.[normalized] || null;
}

// The first `patterns[]` entry whose regex matches this URL — same matching
// logic resolveFile uses for file paths, shared here so pattern-level
// placement config (resolvePlacement below) can reuse it instead of a
// second regex-matching implementation.
function getMatchingPattern(site, pageUrl) {
  const map = site.url_file_map || {};
  if (!pageUrl) return null;
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  for (const p of map.patterns || []) {
    if (!p.match) continue;
    const re = new RegExp(p.match);
    if (re.test(normalized) || re.test(path)) return p;
  }
  return null;
}

// Existing-page generators (schema, meta-title, faq, internal-links,
// translation) resolve against `pages` (exact match) then `patterns` (regex
// with $1-style capture-group substitution, for templated routes like
// /blog/:slug that a single exact-match entry per URL can't cover).
export function resolveFile(site, pageUrl) {
  const entry = getPageEntry(site, pageUrl);
  if (entry?.file) return entry.file;

  const pattern = getMatchingPattern(site, pageUrl);
  if (!pattern?.file) return null;

  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const re = new RegExp(pattern.match);
  const m = normalized.match(re) || path.match(re);
  return m ? pattern.file.replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? '') : null;
}

// Recommended, non-exhaustive slot vocabulary for placement config below —
// documentation/consistency only (e.g. a future UI dropdown), never
// validated against. A site is free to use any other string as a slot name.
export const STANDARD_SLOTS = [
  'metadata', 'head', 'hero', 'page-top', 'content',
  'related-content', 'faq', 'before-footer', 'page-end', 'site-root',
];

// Default slot per action type — WHERE a type conventionally belongs, not
// WHAT fields it produces (that knowledge stays entirely in
// lib/marker-merge.js; this module never hardcodes a type's field names).
// Types with no entry (blog-outline/landing-page/translation — net-new
// content, resolved via resolveNewContentTarget/resolveTranslationTarget
// below, never marker-based) simply have no default placement; that's a
// normal, expected outcome, not an error.
const DEFAULT_SLOT_BY_ACTION_TYPE = {
  'meta-title': 'metadata',
  'faq': 'faq',
  'schema': 'head',
  'internal-links': 'related-content',
  'llms-txt': 'site-root',
  'analytics-install': 'head',
};

// Single source of truth for "where does this (page, action type) land."
// Resolution order, highest priority first:
//   1. page-level `pages[url].placements[actionType]` — { slot?, markers }
//   2. pattern-level `patterns[].placements[actionType]` — same shape,
//      applies to every URL that pattern matches (e.g. one config entry
//      covers every /blog/:slug post instead of configuring each one
//      individually — mirrors how resolveFile already resolves a file path
//      for an unconfigured page via the matching pattern)
//   3. site-level `defaults.placements[actionType]` — same shape, inherited
//      by every page that doesn't set its own (configuration inheritance,
//      for conventions a whole site shares instead of repeating per page)
//   4. legacy flat `pages[url].markers` (pre-placement config, read
//      unmodified — full backward compatibility, no migration required)
//   5. nothing configured — { slot: <default or null>, markers: null }
// `markers` is always a raw `{field: markerName}` object exactly as the
// config author wrote it; this resolver has zero knowledge of which fields
// a given action type actually produces — lib/marker-merge.js's
// spliceMarkers already filters marker entries by whatever fields are
// present in the built values, so that coupling never needs to exist here.
// Marker NAMES are fixed strings, not $1-substituted like resolveFile's
// file paths — a shared marker convention (e.g. "TITLE") is exactly the
// point of configuring it once at the pattern level.
export function resolvePlacement(site, pageUrl, actionType) {
  const defaultSlot = DEFAULT_SLOT_BY_ACTION_TYPE[actionType] || null;
  const entry = getPageEntry(site, pageUrl);

  const pageConfigured = entry?.placements?.[actionType];
  if (pageConfigured) {
    return { slot: pageConfigured.slot || defaultSlot, markers: pageConfigured.markers || null };
  }

  const patternConfigured = getMatchingPattern(site, pageUrl)?.placements?.[actionType];
  if (patternConfigured) {
    return { slot: patternConfigured.slot || defaultSlot, markers: patternConfigured.markers || null };
  }

  const siteConfigured = site.url_file_map?.defaults?.placements?.[actionType];
  if (siteConfigured) {
    return { slot: siteConfigured.slot || defaultSlot, markers: siteConfigured.markers || null };
  }

  if (entry?.markers) return { slot: defaultSlot, markers: entry.markers };

  return { slot: defaultSlot, markers: null };
}

// Marker names for a splice-based merge (meta-title/faq — see
// implementers/lib/marker-merge.js), e.g. { title: "TITLE", faq: "FAQ" }.
// Thin projection of resolvePlacement — kept as its own export since most
// callers (backend.js) only ever need the markers, not the slot.
export function resolveMarkers(site, pageUrl, actionType) {
  return resolvePlacement(site, pageUrl, actionType).markers;
}

// Adapter routing: whether a (page, action type) is routed to a named
// adapter (server/implementers/adapters/<id>.js) instead of the default
// backend/frontend implementer. This is a routing/integration decision
// (which framework-specific code owns writing the change), not a content-
// placement judgment call — so unlike render mode below, it stays explicit,
// static config; there's no "evidence in the page" that tells you which
// adapter to use. `url_file_map.pages[url].adapters` (or `.patterns[].adapters`
// for a whole family of pages sharing one data-driven target, e.g. every
// /locations/:slug/ page routing to the same generic data-array adapter)
// shape: { [actionType]: { id: 'adapter-id', ...adapter-specific params } }
// — e.g. data-array-content.js expects { id, format, dataFile, idField,
// itemsField }. The object (not just a bare id string) is what makes the
// adapter itself generic/reusable across tenants: which FILE and which
// FIELD NAMES to use are per-site config, never hardcoded in the adapter's
// own code. Page-level wins over pattern-level. No config → no adapter,
// default routing.
//
// This is the deliberate seam for "content-only" generation: an adapter
// writes pure structured content into a file the SITE's own template
// already renders with its own current styling (see
// adapters/data-array-content.js), never HTML/CSS. The default routing —
// marker-merge.js splicing a componentTemplates-supplied HTML template — is
// the correct, permanent fallback for any (site, page, action type) that
// has no real site-side component to write into yet, not a mechanism to
// eliminate outright. Expect this fallback's footprint to shrink over time
// as more pages grow real, data-driven components (and more adapter config
// gets added here to route to them) — never auto-detected or LLM-guessed:
// a wrong adapter-routing guess can corrupt a file every page's build
// imports (breaking the whole site's build), a materially higher blast
// radius than a wrong render-mode guess below, which affects one page.
export function resolveAdapter(site, pageUrl, actionType) {
  const entry = getPageEntry(site, pageUrl);
  if (entry?.adapters?.[actionType]) return entry.adapters[actionType];
  return getMatchingPattern(site, pageUrl)?.adapters?.[actionType] || null;
}

// Render mode (visible vs. schema-only) is NOT resolved here, and
// deliberately has no static config surface — see
// implementers/lib/render-inspector.js. It's decided fresh on every call by
// inspecting the actual live file content (deterministic evidence first,
// LLM only when genuinely ambiguous), never read from a stored decision,
// so it always reflects the template's current state rather than whatever
// was true the last time someone looked.

// Net-new-content generators (blog-outline, landing-page) have no existing
// URL — resolves a deterministic new file path from the configured target
// directory/extension plus a slugified title.
export function resolveNewContentTarget(site, actionType, title) {
  const target = site.url_file_map?.newContentTargets?.[actionType];
  if (!target?.dir || !target?.extension) return null;
  const slug = String(title || 'untitled')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
  return `${target.dir}/${slug}${target.extension}`;
}

// Site-level (not per-page) targets — today only llms.txt/robots.txt.
export function resolveSiteRootFile(site, key) {
  return site.url_file_map?.siteRoot?.[key] || null;
}

// Common language name -> ISO 639-1 code, for targetLanguage values an LLM
// might return as a full name (e.g. "Spanish") rather than a code. Best-
// effort only — an unrecognized name falls back to a short slug rather than
// failing, since the exact code matters less than the file simply landing
// somewhere real and reviewable.
const LANGUAGE_CODES = {
  spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', italian: 'it',
  japanese: 'ja', chinese: 'zh', 'simplified chinese': 'zh', 'traditional chinese': 'zh',
  korean: 'ko', arabic: 'ar', hindi: 'hi', nepali: 'ne', russian: 'ru', dutch: 'nl',
  vietnamese: 'vi', thai: 'th', indonesian: 'id', turkish: 'tr', polish: 'pl',
};
function languageCode(targetLanguage) {
  const norm = String(targetLanguage || '').trim().toLowerCase();
  if (!norm) return 'xx';
  if (/^[a-z]{2}$/.test(norm)) return norm; // already a 2-letter code
  if (LANGUAGE_CODES[norm]) return LANGUAGE_CODES[norm];
  return norm.replace(/[^a-z]/g, '').slice(0, 2) || 'xx';
}

// Translation has no `newContentTargets` entry of its own — its real target
// is a language-suffixed sibling of the SOURCE page's own real file
// (about.njk -> about.es.njk), derived from resolveFile's already-resolved
// path, not a separate directory/extension config. No existing route in
// this codebase's `pages`/`patterns` convention needs to know about
// translated variants ahead of time for this to work.
export function resolveTranslationTarget(sourcePath, targetLanguage) {
  if (!sourcePath) return null;
  const code = languageCode(targetLanguage);
  return sourcePath.replace(/(\.[^./]+)$/, `.${code}$1`);
}
