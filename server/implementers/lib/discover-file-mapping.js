import { getRepoTree } from '../../github/client.js';
import { baseBranch } from './github-ops.js';
import { resolveFile, resolveAdapter } from './url-file-map.js';
import { updateSiteRepoConfig } from '../../db.js';

// Action-type-agnostic file discovery, extracted from
// server/scripts/discover-url-file-map.js so it has exactly one
// implementation instead of two independently-maintained copies — that
// script's own faq-specific data-loop verification stays there (it's real
// adapter-routing logic, not file discovery), but "find the one real file in
// the repo whose name matches this URL" is generic and now shared by both
// the manual CLI and autoHealFileMapping below.

const TEMPLATE_EXTENSIONS = ['njk', 'html', 'liquid', 'hbs', 'ejs', 'md'];

export function normalizedPath(pageUrl) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

// Finds a single, real candidate file by matching the URL's last path
// segment against real filenames in the repo's own tree — never a
// framework-convention guess. Multiple matches are disambiguated using the
// URL's other segments as directory hints; anything still ambiguous is
// reported, not picked for.
export function findCandidateFile(pageUrl, repoFiles) {
  const segments = normalizedPath(pageUrl).split('/').filter(Boolean);
  if (!segments.length) return { kind: 'ambiguous', candidates: [] };
  const lastSegment = segments[segments.length - 1];

  const extPattern = new RegExp(`/${lastSegment}\\.(${TEMPLATE_EXTENSIONS.join('|')})$`);
  let candidates = repoFiles.filter((f) => extPattern.test(`/${f}`));

  if (candidates.length > 1 && segments.length > 1) {
    const otherSegments = segments.slice(0, -1);
    const narrowed = candidates.filter((f) => otherSegments.every((seg) => f.includes(seg)));
    if (narrowed.length) candidates = narrowed;
  }

  if (candidates.length === 1) return { kind: 'resolved', file: candidates[0] };
  return { kind: 'ambiguous', candidates };
}

// The self-healing counterpart to discover-url-file-map.js's manual CLI:
// called inline the first time a push actually needs a page's file path
// instead of waiting for someone to remember to run the script and re-apply
// its output. Same evidence bar as the CLI (exactly one real filename
// match, or nothing is written) — never guesses, never partially trusted.
// Returns the resolved site (with url_file_map updated) on success, or null
// if nothing could be safely resolved.
export async function autoHealFileMapping(site, pageUrl, actionType) {
  if (!site.repo_owner || !site.repo_name) return null;
  if (resolveFile(site, pageUrl)) return null; // already resolvable, nothing to heal
  if (resolveAdapter(site, pageUrl, actionType)) return null; // adapter-routed pages are a separate concern, not a missing file mapping

  const branch = baseBranch(site);
  const tree = await getRepoTree(site, branch);
  const candidate = findCandidateFile(pageUrl, tree.files);
  if (candidate.kind !== 'resolved') return null;

  const path = normalizedPath(pageUrl);
  const cfg = JSON.parse(JSON.stringify(site.url_file_map || {}));
  cfg.pages = cfg.pages || {};
  cfg.pages[path] = { ...(cfg.pages[path] || {}), file: candidate.file };

  console.log(`[auto-heal] url_file_map: discovered "${path}" -> ${candidate.file} for site #${site.id}, persisting.`);
  return updateSiteRepoConfig({ siteId: site.id, urlFileMap: cfg });
}
