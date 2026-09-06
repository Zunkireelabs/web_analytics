// Resolves a draft to a real file path in the site's repo using the explicit,
// human-populated `sites.url_file_map` config (see migration 028) — this
// module NEVER guesses a path from framework conventions. If nothing in the
// map matches, callers must treat that as an honest "not configured yet"
// failure (reason: 'no-file-mapping'), not attempt a fallback guess.

import { knownDomain, hostnameOf } from '../../agents/lib/site-domain.js';

// `pages`/`patterns` at the TOP of url_file_map are host-agnostic by
// original design — every site used to have exactly one hostname, so a bare
// path was the whole identity of a page. That stopped being true the moment
// a site could register more than one real hostname (additional_own_domains,
// migration 123 — a hero product on its own subdomain, e.g. Zunkiree Labs'
// edgex.zunkireelabs.com CRM alongside the main marketing site): `/` and
// `/contact/` exist on EVERY hostname, and without hostname in the identity,
// resolving edgex.zunkireelabs.com/ silently returned the MAIN site's
// homepage file — a real incident, not a hypothetical (dismissed
// recommendations 60-63/71/78-89 on site 1, 2026-08-24).
//
// Fix: hostname is now part of a page's identity, via a NEW,
// EXPLICIT-ONLY `url_file_map.hosts[hostname] = { pages, patterns }`
// namespace, resolved here — everything below this point (resolveFile,
// resolveAdapter, resolvePlacement, resolveLinkDataSources, isPageMapped)
// is unaffected: they all still just call getPageEntry/getMatchingPattern.
//
// Scoping rule, in order:
//   1. No hostname could be parsed from pageUrl (a bare path was passed —
//      every internal caller that already did this keeps working exactly as
//      before), OR the site has no `website_domain` configured yet (nothing
//      to compare a hostname against) -> LEGACY scope: the flat top-level
//      `pages`/`patterns`, unchanged, unscoped. This is what keeps every
//      existing single-hostname site's mappings working with zero migration.
//   2. hostname === the site's own primary website_domain -> PRIMARY scope:
//      also the flat top-level `pages`/`patterns` — the common case (one
//      hostname per site) behaves identically to before this change.
//   3. Any other hostname (a registered additional_own_domain, OR a foreign
//      one — this function does not itself distinguish the two; the
//      own-domain guard in discover-file-mapping.js's autoHealFileMapping is
//      what refuses a foreign one before ever reaching here) -> HOST scope:
//      `url_file_map.hosts[hostname]`, which starts empty and is populated
//      ONLY by an explicit config write. A path with no entry here resolves
//      to nothing, however identical it looks to a path the primary domain
//      already has mapped — that is the whole fix.
export function resolveHostScope(site, pageUrl) {
  const map = site?.url_file_map || {};
  const host = hostnameOf(pageUrl);
  const primary = knownDomain(site);
  if (!host || !primary || host === primary) {
    return { pages: map.pages || {}, patterns: map.patterns || [], scope: host && primary ? 'primary' : 'legacy', host: host || primary || null };
  }
  const hostMap = map.hosts?.[host];
  return { pages: hostMap?.pages || {}, patterns: hostMap?.patterns || [], scope: 'host', host };
}

// Shared by every resolver below — normalizes a page URL to its pathname
// (with/without a trailing slash) and looks up the matching `pages` entry
// from the correct hostname scope (see resolveHostScope above), so both
// path-normalization AND host-scoping logic exist exactly once.
function getPageEntry(site, pageUrl) {
  if (!pageUrl) return null;
  const { pages } = resolveHostScope(site, pageUrl);
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return pages?.[path] || pages?.[normalized] || null;
}

// The first `patterns[]` entry whose regex matches this URL, from the
// correct hostname scope — same matching logic resolveFile uses for file
// paths, shared here so pattern-level placement config (resolvePlacement
// below) can reuse it instead of a second regex-matching implementation.
function getMatchingPattern(site, pageUrl) {
  if (!pageUrl) return null;
  const { patterns } = resolveHostScope(site, pageUrl);
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  for (const p of patterns || []) {
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

// Whether a (page, actionType) recommendation could ever actually apply —
// checked BEFORE a recommendation is persisted/surfaced (see
// agents/lib/recommendations.js's buildRecommendations) instead of only
// discovering "No url_file_map entry matches" at approve/apply time
// (backend.js/frontend.js's own resolveFile calls). Real incident: a
// /compare/:slug pattern configured `adapters` for faq/meta-title but not
// schema, so geo-signals.js's Review/AggregateRating schema finding kept
// generating an "auto-eligible" recommendation that failed every time
// someone tried to apply it. An adapter route is trusted on its own
// (without also requiring resolveFile) — an adapter's dataFile is a
// separate concern it validates itself, at apply time.
export function isPageMapped(site, pageUrl, actionType) {
  if (resolveAdapter(site, pageUrl, actionType)) return true;
  return !!resolveFile(site, pageUrl);
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

// Additional candidate files broken-link-fix's Layer 1 should also check for
// a page, beyond the page's own mapped template file (resolveFile above) —
// for a link that's rendered by a SHARED layout from a data array, not
// hardcoded in the page's own file at all (e.g. zunkireelabs-web's product
// pages: `src/pages/products/<id>.njk` is just front-matter, the real
// "Resources" links render from `src/_data/productsDetails.json`'s
// `resources[]`, via the shared `product.njk` layout — confirmed 2026-08-10
// investigating a stuck broken-link-fix draft where neither the mapped page
// file nor GitHub code search could find the link). Unlike resolveAdapter,
// this is never a full replacement for who writes the change — it's purely
// more places to LOOK, so backend.js's own Layer 1 still tries resolveFile's
// page-template file first, same file-content-plus-regex verification
// either way (never trusted on config alone). Shape: [{ dataFile, itemsField,
// urlField, format? }, ...] — `format` defaults to 'json-array' (see
// js-data-splice.js's removeArrayItemByField, the only format it supports
// today). The per-entry id to match within dataFile is always the page URL's
// own last path segment (same convention as adapters/data-array-content.js's
// idFromPageUrl) — no separate idField needed since every real case so far
// is "one entry per page, keyed by its own URL slug."
export function resolveLinkDataSources(site, pageUrl) {
  const entry = getPageEntry(site, pageUrl);
  if (entry?.linkDataSources) return entry.linkDataSources;
  return getMatchingPattern(site, pageUrl)?.linkDataSources || [];
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
  return `${target.dir}/${slugifyTitle(title)}${target.extension}`;
}

// The single slug both the file path above and the public URL below derive
// from — they must agree, or a page gets written to one place and declares
// it lives at another.
function slugifyTitle(title) {
  return String(title || 'untitled')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

// The public URL path that same new page will live at — the other half of
// resolveNewContentTarget, and what lets a new page reach the site's sitemap
// without a second draft and a second PR.
//
// This exists because a static-site generator decides a page's URL at BUILD
// time from the page's own front matter, not from where its file sits.
// zunkireelabs-web's sitemap is src/sitemap.njk (permalink: /sitemap.xml)
// iterating collections.all, so every page Eleventy builds is already in the
// sitemap automatically and the sitemap file itself needs no edit — there is
// no sitemap.xml in the repo to edit. What a new page actually needs is a
// correct `permalink`. That site's own two directories show why it can't be
// inferred: src/blog/blog.json sets "permalink": "/blog/{{ page.fileSlug }}/"
// for every post (so blog posts are already correct), while src/pages/*.njk
// each carry their own explicit `permalink: /about/` with no directory
// default — a new file dropped into src/pages/ would publish at Eleventy's
// fallback /pages/<slug>/ and be listed in the sitemap at that wrong URL.
//
// `urlPattern` is therefore per-target CONFIG ("/services/{slug}/"), not
// inference: the directory -> URL mapping is a property of the site's build
// setup this code cannot observe, and a guessed URL is worse than none — it
// would publish a real page at a URL that 404s and then advertise that URL
// in the sitemap. No urlPattern (or an unusable one) returns null, and every
// caller falls back to exactly today's behavior: write the page, add no
// permalink, let the build decide.
// The `layout` a genuinely-new page should declare, so it renders inside the
// site's real chrome (navbar/footer/head) instead of as a bare document with
// correct content and no site around it.
//
// Resolved from the configured siteRoot.layoutTemplate by BASENAME, because
// that is what a layout front-matter value actually means: Eleventy resolves
// it relative to `dir.layouts`, not to the project root. Confirmed against
// the real repo rather than assumed — zunkireelabs-web's .eleventy.js sets
// dir.layouts = "_includes/layouts", its layoutTemplate config is
// "src/_includes/layouts/base.njk", and its own src/pages/about.njk declares
// exactly `layout: base.njk`.
//
// The per-target override exists for one real, non-hypothetical reason: a
// directory data file can already supply a layout for everything in that
// directory, and front matter OVERRIDES directory data. On this same site
// src/blog/blog.json sets "layout": "blog-post.njk" for every post, so
// emitting the generic site layout on a new blog post would silently
// downgrade it from the blog layout to the base one. Setting
// newContentTargets["blog-outline"].layout = null suppresses it for that
// target; a string overrides it outright.
//
// Nothing configured -> null -> the key is omitted and the build decides,
// exactly as today. Deliberately conservative: a layout name that doesn't
// resolve is not a cosmetic problem, it fails the site BUILD, so this only
// ever emits a name derived from real configuration, never a guess.
// The raw { dir, extension } a net-new target writes into — the same config
// resolveNewContentTarget builds a file path from, exposed on its own so
// newcontent-contract.js can read that directory's existing files without
// re-deriving the config or being handed an already-slugified path.
export function resolveNewContentTargetConfig(site, actionType) {
  const target = site?.url_file_map?.newContentTargets?.[actionType];
  if (!target?.dir || !target?.extension) return {};
  return { dir: target.dir, extension: target.extension };
}

export function resolveNewContentLayout(site, actionType) {
  const target = site?.url_file_map?.newContentTargets?.[actionType];
  // Explicit per-target config wins, including an explicit null/'' meaning
  // "this directory already supplies its own layout — do not emit one."
  if (target && 'layout' in target) return target.layout || null;

  const configured = site?.url_file_map?.siteRoot?.layoutTemplate;
  if (!configured) return null;
  const basename = configured.split('/').filter(Boolean).pop();
  return basename || null;
}

export function resolveNewContentUrl(site, actionType, title) {
  const urlPattern = site.url_file_map?.newContentTargets?.[actionType]?.urlPattern;
  if (!urlPattern || !urlPattern.includes('{slug}')) return null;
  const url = urlPattern.replace('{slug}', slugifyTitle(title));
  // Must be a site-root-relative path. Anything else — a full URL, a
  // traversal, a doubled separator from an empty segment — is malformed
  // config, not something to normalize into a guess.
  if (!url.startsWith('/') || url.includes('..') || url.includes('//')) return null;
  return url;
}

// Where a page that SHOULD exist at `href` would have to be written, derived
// from the real files of its already-existing siblings rather than from
// per-target config.
//
// missing-page-create deliberately does not use resolveNewContentTarget's
// newContentTargets config, for two reasons. First, that config is one fixed
// dir+extension per action type, but a missing page can be missing from any
// section (/resources/, /blog/, /guides/) and each maps to a different
// directory — one config key cannot express that. Second, requiring new
// per-site config would gate this behind an onboarding step on every tenant,
// when the answer is already sitting in the url_file_map entries the
// siblings resolve through.
//
// The siblings passed here are the same ones dead-link-intent.js required
// before allowing creation at all, so if this returns null the caller has
// already lost nothing: it falls back to removing the link.
//
// The slug comes from the dead URL itself, never from a slugified title — the
// whole point is to make THAT href resolve, and a page written at any other
// slug would leave the original link just as broken.
export function resolveMissingPageTarget(site, href, siblings = []) {
  let slug;
  try {
    slug = new URL(href).pathname.split('/').filter(Boolean).pop() || '';
  } catch { return null; }
  // The slug lands in a repo path, so anything that could escape the target
  // directory or name a file we didn't intend disqualifies it outright.
  if (!slug || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug) || slug.includes('..')) return null;
  const bareSlug = slug.replace(/\.[a-zA-Z0-9]+$/, '');
  if (!bareSlug) return null;

  for (const sibling of siblings) {
    const file = resolveFile(site, sibling);
    if (!file) continue;
    const lastSlash = file.lastIndexOf('/');
    if (lastSlash < 0) continue;
    const dir = file.slice(0, lastSlash);
    const dot = file.lastIndexOf('.');
    const extension = dot > lastSlash ? file.slice(dot) : '';
    if (!extension) continue;
    return { filePath: `${dir}/${bareSlug}${extension}`, dir, extension, modelFile: file };
  }
  return null;
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
