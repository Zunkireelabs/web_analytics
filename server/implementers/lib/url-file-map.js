// Resolves a draft to a real file path in the site's repo using the explicit,
// human-populated `sites.url_file_map` config (see migration 028) — this
// module NEVER guesses a path from framework conventions. If nothing in the
// map matches, callers must treat that as an honest "not configured yet"
// failure (reason: 'no-file-mapping'), not attempt a fallback guess.

// Existing-page generators (schema, meta-title, faq, internal-links,
// translation) resolve against `pages` (exact match) then `patterns` (regex
// with $1-style capture-group substitution, for templated routes like
// /blog/:slug that a single exact-match entry per URL can't cover).
export function resolveFile(site, pageUrl) {
  const map = site.url_file_map || {};
  if (!pageUrl) return null;

  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;

  if (map.pages?.[path]?.file) return map.pages[path].file;
  if (map.pages?.[normalized]?.file) return map.pages[normalized].file;

  for (const p of map.patterns || []) {
    if (!p.match || !p.file) continue;
    const re = new RegExp(p.match);
    const m = normalized.match(re) || path.match(re);
    if (m) return p.file.replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? '');
  }
  return null;
}

// Marker names for a splice-based merge (meta-title/faq — see
// implementers/lib/marker-merge.js), e.g. { title: "TITLE", faq: "FAQ" }.
// Only supported on exact `pages` entries, not regex `patterns` — a
// templated route matched by a pattern would need the same marker names on
// every page it matches anyway, so there's no real benefit to supporting it
// there yet, and it keeps this resolver simple.
export function resolveMarkers(site, pageUrl) {
  const map = site.url_file_map || {};
  if (!pageUrl) return null;
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return map.pages?.[path]?.markers || map.pages?.[normalized]?.markers || null;
}

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
