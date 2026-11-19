import { resolveFile } from '../implementers/lib/url-file-map.js';
import { adoptHeadTags } from '../implementers/lib/head-tag-adopt.js';

// Points the open-graph and canonical fixes of each page at the file that really holds those tags, for sites where that is NOT the page file:
// an Eleventy site converted from static HTML keeps each page's `<head>` in a per-page include, named by the page's own front matter
// (`"headInclude": "heads/services-index.njk"`, found under src/_includes/). Pure apart from the injected readFile.
//
// Strict: a page is configured only when its page file names a head include, that file exists in the repository, and it holds at least one tag
// the fix would write (so the fix has something to adopt). Anything else is reported with its reason and left as it was. A page that already
// has a configured file for a type keeps it. The result is a new map; the input is never changed.

const FRONT_MATTER_KEY = [/"headInclude"\s*:\s*"([^"]+)"/, /^headInclude:\s*["']?([^\s"']+)["']?\s*$/m];
export const INCLUDES_DIR = 'src/_includes/';

export function headIncludeOf(pageFileContent) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(pageFileContent || '');
  if (!fm) return null;
  for (const re of FRONT_MATTER_KEY) { const m = re.exec(fm[1]); if (m) return m[1]; }
  return null;
}

export async function planHeadTargets({ siteMap = {}, pages = [], host = null, repoFiles = [], readFile }) {
  const files = new Set(repoFiles.map((f) => (typeof f === 'string' ? f : f.path)));
  const site = { website_domain: host, url_file_map: siteMap };
  const nextPages = { ...(siteMap.pages || {}) };
  const configured = []; const skipped = [];

  for (const page of pages) {
    let path; try { path = new URL(page).pathname; } catch { path = page; }
    const key = path.length > 1 ? path.replace(/\/+$/, '') : path;
    const pageFile = resolveFile(site, page);
    if (!pageFile) { skipped.push({ page, reason: 'no template file mapped' }); continue; }
    const pageContent = await readFile(pageFile);
    const include = headIncludeOf(pageContent);
    if (!include) { skipped.push({ page, reason: 'the page file names no head include' }); continue; }
    const headFile = `${INCLUDES_DIR}${include}`;
    if (!files.has(headFile)) { skipped.push({ page, reason: `${headFile} does not exist in the repository` }); continue; }
    const headContent = await readFile(headFile);

    const entry = { ...(nextPages[key] || { file: pageFile }) };
    const placements = { ...(entry.placements || {}) };
    const got = [];
    for (const [actionType, field, marker] of [['open-graph', 'openGraph', 'OPENGRAPH'], ['canonical', 'canonical', 'CANONICAL']]) {
      if (placements[actionType]?.file) continue;                                     // already configured: kept
      const probe = adoptHeadTags(headContent, field, marker, headFile);
      if (!probe.ok) { skipped.push({ page, reason: `${actionType}: ${probe.reason}` }); continue; }
      placements[actionType] = { file: headFile };
      got.push(actionType);
    }
    if (!got.length) continue;
    nextPages[key] = { ...entry, placements };
    configured.push({ page, headFile, types: got });
  }
  if (!configured.length) return { ok: false, reason: 'no page could be pointed at a head file', skipped };
  return { ok: true, nextMap: { ...siteMap, pages: nextPages }, configured, skipped };
}
