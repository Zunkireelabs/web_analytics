import { resolveFile } from '../implementers/lib/url-file-map.js';

// Adds ONE regex pattern to a project's url_file_map so a whole family of pages (every /blog/<slug>/) resolves to its template file
// without an entry per page. Pure: facts in (the current map, the page addresses, the files that really exist in the repo), a verdict
// and the next map out. scripts/add-url-pattern.js reads the facts and saves the map; nothing here touches a database or GitHub.
//
// Strict on purpose, because a wrong pattern makes the daily run edit the wrong file on every page it matches:
//   - every page the pattern newly maps must resolve to a file that exists in the repository (one miss and nothing is written),
//   - a page that already has its own entry keeps it (an explicit entry always wins),
//   - the same pattern twice, a pattern with no new pages, an invalid regex or a file template that does not use its capture
//     group are all refused with the reason.
export function planUrlPattern({ siteMap = {}, match, file, pages = [], repoFiles = [], host = null, replace = false }) {
  let re;
  try { re = new RegExp(match); } catch (err) { return { ok: false, reason: `the match is not a valid regular expression (${err.message.slice(0, 60)})` }; }
  if (!file || /\.\./.test(file) || file.startsWith('/')) return { ok: false, reason: 'the file must be a relative path inside the repository' };
  const groups = new RegExp(`${match}|`).exec('').length - 1;
  if (groups > 0 && !/\$\d/.test(file)) return { ok: false, reason: 'the pattern has a capture group but the file does not use it ($1), so every page would map to one file' };
  const existing = Array.isArray(siteMap.patterns) ? siteMap.patterns : [];
  const same = existing.find((p) => p.match === match);
  if (same && !replace) return { ok: false, reason: 'a pattern with this match already exists (pass replace to change its file)' };
  if (same && same.file === file) return { ok: false, reason: 'that pattern already points at this file' };
  if (!same && replace) return { ok: false, reason: 'there is no pattern with this match to replace' };

  // replace: the same pattern, pointed at a different file. Everything the old pattern resolved is checked against the new target.
  const next = { ...siteMap, patterns: same ? existing.map((p) => (p === same ? { ...p, file } : p)) : [...existing, { match, file }] };
  const before = { website_domain: host, url_file_map: siteMap };
  const after = { website_domain: host, url_file_map: next };
  const files = new Set(repoFiles.map((f) => (typeof f === 'string' ? f : f.path)));

  const newlyMapped = []; const alreadyMapped = []; const misses = [];
  for (const page of pages) {
    const was = resolveFile(before, page);
    const now = resolveFile(after, page);
    if (was && was === now) { alreadyMapped.push(page); continue; }   // an explicit entry, or another pattern, keeps the page
    if (!now) continue;                                         // not matched by this pattern
    if (files.has(now)) newlyMapped.push({ page, file: now }); else misses.push({ page, file: now });
  }
  if (misses.length) return { ok: false, reason: `${misses.length} page(s) would map to a file that does not exist in the repository, e.g. ${misses[0].page} -> ${misses[0].file}`, misses };
  if (!newlyMapped.length) return { ok: false, reason: same ? 'the new file changes the mapping of no known page' : 'the pattern maps no page that is not already mapped' };
  return { ok: true, nextMap: next, newlyMapped, alreadyMapped: alreadyMapped.length, regex: re.source, replaced: same ? same.file : null };
}

// Exact page entries ({ "/": "src/index.njk" }): for the few pages no pattern covers (a home page, a contact page). Same strictness: the file
// must exist, and a page that already has an entry is never overwritten silently.
export function planPageEntries({ siteMap = {}, entries = [], repoFiles = [] }) {
  const files = new Set(repoFiles.map((f) => (typeof f === 'string' ? f : f.path)));
  const pages = { ...(siteMap.pages || {}) };
  const added = [];
  for (const { path, file } of entries) {
    if (!path || !path.startsWith('/')) return { ok: false, reason: `"${path}" is not a page path (it must start with /)` };
    if (!file || /\.\./.test(file) || file.startsWith('/')) return { ok: false, reason: `"${file}" is not a relative path inside the repository` };
    if (!files.has(file)) return { ok: false, reason: `${file} does not exist in the repository (for ${path})` };
    if (pages[path]) {
      if (pages[path].file === file) continue;
      return { ok: false, reason: `${path} already maps to ${pages[path].file}; this will not overwrite it` };
    }
    pages[path] = { file };
    added.push({ path, file });
  }
  if (!added.length) return { ok: false, reason: 'every one of these pages is already mapped to that file' };
  return { ok: true, nextMap: { ...siteMap, pages }, added };
}
