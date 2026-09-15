// Removes specific <url> entries from a sitemap.xml body — the deliberate
// counterpart to generators/sitemap.js, which is additive-only by design
// (most tenants' own build regenerates their sitemap from source, so
// guessing at removal there would fight that build; see that file's own
// comment). This is only ever offered for the sub-case where THIS platform
// is already the one hand-maintaining the tracked sitemap file (a site with
// no build-time sitemap generation of its own, url_file_map.siteRoot.sitemap
// configured) and Google's own index inspection has confirmed the listed
// URL is currently blocked/excluded/non-canonical — i.e. undoing the
// platform's OWN prior "add this to the sitemap" action (or agreeing with a
// state that's been true for a while), never touching the actual
// indexability signal (robots.txt/noindex) itself.
//
// Self-correcting by construction: if the underlying exclusion is ever
// fixed (a noindex tag removed, a robots.txt rule loosened), sitemap.js's
// own existing "URL missing from sitemap" detection re-adds it automatically
// on its next run — no separate undo mechanism needed.
//
// All-or-nothing, same discipline as duplicate-id-fix's fixPlan: if ANY
// requested URL isn't found as an exact <url>...<loc>URL</loc>...</url>
// block, NONE are removed. A partial removal a reviewer can't easily
// interpret is worse than refusing the whole draft.

function normalizeLoc(text) {
  return text.trim();
}

// Non-greedy match of each <url>...</url> block, tolerant of attributes/
// whitespace nginx-adjacent tools might add, but never assumes nested
// <url> tags (sitemap.xml's schema has none).
const URL_BLOCK_RE = /<url\b[^>]*>[\s\S]*?<\/url>/g;
const LOC_RE = /<loc\b[^>]*>([\s\S]*?)<\/loc>/;

export function removeUrlsFromSitemap(xmlContent, removeUrls) {
  const wanted = new Set(removeUrls.map(normalizeLoc));
  const blocks = xmlContent.match(URL_BLOCK_RE) || [];

  const found = new Set();
  const keptBlocks = [];
  for (const block of blocks) {
    const locMatch = LOC_RE.exec(block);
    const loc = locMatch ? normalizeLoc(locMatch[1]) : null;
    if (loc && wanted.has(loc)) {
      found.add(loc);
      continue; // drop this block
    }
    keptBlocks.push(block);
  }

  const missing = [...wanted].filter((u) => !found.has(u));
  if (missing.length) {
    return {
      ok: false, reason: 'no-match',
      error: `${missing.length} of ${wanted.size} URL(s) requested for removal could not be found as an exact <url><loc>...</loc></url> entry in the live sitemap — it may already have been removed, or the sitemap's structure has changed since detection: ${missing.join(', ')}`,
    };
  }

  // Replace each removed block's occurrence in the original text (preserves
  // exact surrounding whitespace/formatting for every KEPT block, rather
  // than reconstructing the file from the matched blocks alone, which would
  // silently normalize whitespace/ordering the site's own build might care
  // about).
  let newContent = xmlContent;
  for (const block of blocks) {
    const locMatch = LOC_RE.exec(block);
    const loc = locMatch ? normalizeLoc(locMatch[1]) : null;
    if (loc && wanted.has(loc)) {
      newContent = newContent.replace(block, '');
    }
  }
  // Collapse the now-empty lines the removed blocks leave behind — cosmetic
  // only, never changes which URLs remain.
  newContent = newContent.replace(/\n[ \t]*\n(\s*\n)+/g, '\n\n');

  return { ok: true, newContent, removedCount: found.size };
}
