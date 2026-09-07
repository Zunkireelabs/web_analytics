// Repository-local replacement for GitHub's /search/code Layer 2 fallback
// (see backend.js's computeBrokenLinkFixMerge) — GitHub App installation
// tokens silently return empty results from /search/code on private repos,
// a real, widely-reported GitHub platform limitation (not something this
// app's implementation can work around by "using the App correctly"; see
// github.com/orgs/community/discussions/113651, confirmed by multiple
// independent reporters). Since every site here now authenticates as an App
// installation, code search can never work as Layer 2 without a separate,
// narrowly-scoped classic PAT (client.js's GITHUB_PAT_SEARCH) — this module
// gives Layer 2 a real fallback that needs no such PAT at all.
//
// Finds the same class of candidate — a file containing a literal href,
// when url_file_map has no entry/anchor for any of a finding's known source
// pages — using only the Git Trees and Contents APIs, both fully
// App-token-compatible (unlike /search/code).
//
// Deliberately bounded, not a repo-wide grep: the tree listing is one call
// (Git Trees API, recursive) and cheap regardless of repo size, but content
// is only fetched for real template/markup files (a hardcoded href can only
// live in one of these — a shared data file is already handled separately,
// see computeBrokenLinkFixMerge's own Layer 1.5 / resolveLinkDataSources),
// capped at MAX_LOCAL_SEARCH_FILES fetches, prioritized toward directories
// already known to be relevant (the recommendation's own source pages).

import { getRepoTree, getFileContent } from '../../github/client.js';

// An href can only be hardcoded in one of these; anything else (a data file,
// an image, a lockfile, ...) is either handled elsewhere or cannot contain
// a rendered link at all.
const CONTENT_EXTENSIONS = new Set([
  '.njk', '.html', '.htm', '.md', '.mdx', '.astro', '.vue', '.jsx', '.tsx',
  '.liquid', '.hbs', '.handlebars', '.pug', '.ejs',
]);

// Vendor/build-output directories a tenant's own content never lives in —
// excluded so the file cap below is spent on real candidates, not noise.
const EXCLUDED_DIR_PREFIXES = ['node_modules/', '.git/', 'dist/', 'build/', '_site/', '.next/', '.github/', '.vercel/', 'coverage/'];

// One marketing/content site's worth of template files, generously — bounds
// worst-case Contents API calls per search the same way
// CODE_SEARCH_MAX_CANDIDATES bounds /search/code's own result count.
export const MAX_LOCAL_SEARCH_FILES = 80;

function hasContentExtension(path) {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return CONTENT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function isExcluded(path) {
  return EXCLUDED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// Real, bounded local search for any of `literals` across the repo's
// template/markup files at `ref`.
//
// Returns { matches, scanned, truncatedCoverage }:
//   - matches: deduped file paths that contain at least one literal — same
//     shape as client.js's searchCodeForString, so callers need no change
//     to how they consume a Layer 2 result (a candidate list, still
//     re-verified with a real regex match before anything is touched).
//   - scanned: how many files' content was actually fetched and checked —
//     for diagnostics/tests, not correctness.
//   - truncatedCoverage: true when NO match was found AND coverage was
//     provably incomplete (GitHub's own tree truncation, or this
//     function's own file cap) — callers must report that as "not found
//     within a bounded search", never as "confirmed absent from the whole
//     repo", since an external limit (or this function's own bound)
//     genuinely prevented full coverage. false whenever a match was found,
//     or the search covered every real candidate file that exists.
export async function searchRepoLocalForStrings(site, ref, literals, { priorityDirs = [] } = {}) {
  const tree = await getRepoTree(site, ref);
  const allCandidates = tree.files.filter((p) => hasContentExtension(p) && !isExcluded(p));

  let candidates = allCandidates;
  if (candidates.length > MAX_LOCAL_SEARCH_FILES) {
    const priority = candidates.filter((p) => priorityDirs.some((dir) => p.startsWith(dir)));
    const prioritySet = new Set(priority);
    const rest = candidates.filter((p) => !prioritySet.has(p));
    candidates = [...priority, ...rest].slice(0, MAX_LOCAL_SEARCH_FILES);
  }

  const matches = new Set();
  let scanned = 0;
  for (const path of candidates) {
    const file = await getFileContent(site, path, ref);
    if (!file) continue;
    scanned += 1;
    if (literals.some((lit) => file.content.includes(lit))) matches.add(path);
  }

  const coverageIncomplete = tree.truncated || allCandidates.length > MAX_LOCAL_SEARCH_FILES;
  return { matches: [...matches], scanned, truncatedCoverage: matches.size === 0 && coverageIncomplete };
}
