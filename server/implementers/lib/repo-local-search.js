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
// HOW IT READS THE REPO, and why that changed (2026-09-08). The first
// version fetched each candidate file with its own Contents API call, capped
// at MAX_LOCAL_SEARCH_FILES to bound the damage. On a real site that is up to
// 250 requests for ONE broken link, and a single morning's run has many: site
// 1's 2026-09-08 batch spent its entire 5,000/hour budget this way, and the
// call that then failed was the last one of the batch — the shared PR. That
// left 21 fully-pushed drafts with no pull request, which the reconciler
// binned and regenerated the next day, forever (see lib/batch-pr-recovery.js).
// The search wasn't just expensive; it was the thing breaking the ship path
// downstream of it.
//
// So the repo is now read ONCE per (site, ref) as a tarball — the same
// REST-only, App-token-compatible call design-agent/repo-checkout.js already
// uses — and searched in memory. One request instead of hundreds, cached for
// the length of a run so every link checked in the same batch shares it.
//
// Two things follow from that, both good:
//   - coverage is COMPLETE. Every real candidate file in the repo is
//     searched, so "not found" now means absent, not "absent from the first
//     250 files I could afford to look at". The bounded-coverage caveat
//     (truncatedCoverage) survives only for GitHub's own tree truncation on
//     a genuinely huge repo.
//   - MAX_LOCAL_SEARCH_FILES no longer bounds correctness, only memory: it
//     caps how many files are read off disk into the scan.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { getRepoTree, getRepoTarball } from '../../github/client.js';

const execFileAsync = promisify(execFile);

// An href can only be hardcoded in one of these; anything else (an image, a
// lockfile, ...) is either handled elsewhere or cannot contain a rendered
// link at all. .js/.mjs/.ts are included because Eleventy-style `_data/*.js`
// files (e.g. zunkireelabs-web's src/_data/authors.js, holding each author's
// social links) render straight into pages without ever containing markup —
// excluding them made "not found in any file" wrong for a link that plainly
// exists in the repo, just not in a template file.
const CONTENT_EXTENSIONS = new Set([
  '.njk', '.html', '.htm', '.md', '.mdx', '.astro', '.vue', '.jsx', '.tsx',
  '.liquid', '.hbs', '.handlebars', '.pug', '.ejs', '.js', '.mjs', '.ts',
]);

// Vendor/build-output directories a tenant's own content never lives in —
// excluded so the scan is spent on real candidates, not noise.
const EXCLUDED_DIR_PREFIXES = ['node_modules/', 'dist/', 'build/', '_site/', 'coverage/'];

// Every DOT-directory is excluded too, at any depth. Prefix-listing them one
// at a time (.git/, .github/, .next/, .vercel/) was already the pattern here
// and it does not hold: searching zunkireelabs-web completely for the first
// time — the whole repo rather than the first 250 files — returned
// `.claude/skills/schema-generator/SKILL.md` as a candidate for a broken
// link, because a documentation file naturally quotes URLs. Nothing under a
// dot-directory is rendered content a visitor can follow a link from, and
// broken-link-fix rewrites the files handed to it, so a match there is a
// tooling/config file the agent would edit for a link that does not exist on
// the live site. Completeness of coverage makes this class of false
// candidate reachable for the first time, so the exclusion has to be a rule
// rather than a list someone remembers to extend.
function inDotDirectory(path) {
  return path.split('/').slice(0, -1).some((segment) => segment.startsWith('.'));
}

// Now a MEMORY bound, not an API-spend one: the repo arrives in a single
// tarball, so this caps how many files are read off disk and scanned, not
// how many requests are made (that is always exactly one, shared across a
// run). Kept generous enough that a real content site is covered completely
// — zunkireelabs-web has 204 real candidate files against this 250 — so
// "not found" is a statement about the repo rather than about the budget.
// A repo that genuinely exceeds it still reports truncatedCoverage rather
// than claiming a link is absent.
export const MAX_LOCAL_SEARCH_FILES = 250;

function hasContentExtension(path) {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return CONTENT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function isExcluded(path) {
  return inDotDirectory(path) || EXCLUDED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix));
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
// One extracted repo per (site, ref), reused for the length of a run.
//
// The cache is what turns "one request per search" into "one request per
// run": a morning batch checks many links against the same ref, and without
// this each would re-download the tarball. Entries are evicted on TTL rather
// than kept forever — a long-lived process must not answer tomorrow's search
// from yesterday's tree — and the temp directory is removed with them.
const CHECKOUT_TTL_MS = 10 * 60 * 1000;
const checkouts = new Map();

function checkoutKey(site, ref) {
  return `${site.repo_owner}/${site.repo_name}@${ref}`;
}

async function evictExpiredCheckouts(now = Date.now()) {
  for (const [key, entry] of checkouts) {
    if (now - entry.at < CHECKOUT_TTL_MS) continue;
    checkouts.delete(key);
    await rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Removes every extracted checkout. Called by long-running entry points that
// know a run has finished; also safe to call at any time, since a later
// search simply re-extracts.
export async function clearRepoLocalSearchCache() {
  const entries = [...checkouts.values()];
  checkouts.clear();
  await Promise.all(entries.map((e) => rm(e.dir, { recursive: true, force: true }).catch(() => {})));
}

// Downloads and extracts the repo at `ref`, or returns the live checkout.
// In-flight downloads are shared via the stored promise, so N concurrent
// searches on one ref still make exactly ONE request rather than racing each
// other into N.
async function getCheckout(site, ref) {
  await evictExpiredCheckouts();
  const key = checkoutKey(site, ref);
  const cached = checkouts.get(key);
  if (cached) return cached.ready;

  const ready = (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repo-local-search-'));
    const tarPath = join(dir, 'repo.tar.gz');
    try {
      await writeFile(tarPath, await getRepoTarball(site, ref));
      // GitHub nests everything under one generated top-level directory.
      await execFileAsync('tar', ['-xzf', tarPath, '-C', dir, '--strip-components=1']);
      return dir;
    } finally {
      await rm(tarPath, { force: true }).catch(() => {});
    }
  })();

  checkouts.set(key, { ready, dir: null, at: Date.now() });
  try {
    const dir = await ready;
    checkouts.set(key, { ready: Promise.resolve(dir), dir, at: Date.now() });
    return dir;
  } catch (err) {
    // A failed extraction must not be cached — the next search should get a
    // real attempt, not a memoized failure for the rest of the TTL.
    checkouts.delete(key);
    throw err;
  }
}

// Every candidate file path (repo-relative) inside an extracted checkout.
async function walkCandidates(root, dir = root, out = []) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (entry.isDirectory()) {
      if (isExcluded(`${rel}/`)) continue;
      await walkCandidates(root, full, out);
    } else if (entry.isFile() && hasContentExtension(rel) && !isExcluded(rel)) {
      out.push(rel);
    }
  }
  return out;
}

// Real, bounded local search for any of `literals` across the repo's
// template/markup files at `ref`.
//
// Returns { matches, scanned, truncatedCoverage }:
//   - matches: deduped file paths that contain at least one literal — same
//     shape as client.js's searchCodeForString, so callers need no change
//     to how they consume a Layer 2 result (a candidate list, still
//     re-verified with a real regex match before anything is touched).
//   - scanned: how many files' content was actually read and checked —
//     for diagnostics/tests, not correctness.
//   - truncatedCoverage: true when NO match was found AND coverage was
//     provably incomplete. Since the whole repo is now searched, the only
//     remaining source of that is GitHub's own tree truncation (checked via
//     the same cheap recursive tree call as before) or this function's own
//     memory cap being hit — both genuinely rare, and both meaning "not
//     found within a bounded search", never "confirmed absent from the whole
//     repo".
//
// `priorityDirs` no longer decides WHAT gets searched — everything does —
// but still orders the scan so a match in a known-relevant directory is
// found before the rest of the repo is read.
export async function searchRepoLocalForStrings(site, ref, literals, { priorityDirs = [] } = {}) {
  const root = await getCheckout(site, ref);
  const allCandidates = await walkCandidates(root);

  const priority = allCandidates.filter((p) => priorityDirs.some((dir) => p.startsWith(dir)));
  const prioritySet = new Set(priority);
  const ordered = [...priority, ...allCandidates.filter((p) => !prioritySet.has(p))];
  const candidates = ordered.slice(0, MAX_LOCAL_SEARCH_FILES);

  const matches = new Set();
  let scanned = 0;
  for (const path of candidates) {
    const content = await readFile(join(root, path), 'utf8').catch(() => null);
    if (content === null) continue;
    scanned += 1;
    if (literals.some((lit) => content.includes(lit))) matches.add(path);
  }

  // The tree call stays purely to learn whether GITHUB truncated its own
  // listing — the one coverage limit a full checkout cannot rule out. It is
  // one cheap request and never gates the search itself, so a failure here
  // is not allowed to fail a search that has already succeeded.
  let treeTruncated = false;
  try {
    treeTruncated = (await getRepoTree(site, ref)).truncated === true;
  } catch { /* coverage unknown; the scan above still stands */ }

  const coverageIncomplete = treeTruncated || ordered.length > MAX_LOCAL_SEARCH_FILES;
  return { matches: [...matches], scanned, truncatedCoverage: matches.size === 0 && coverageIncomplete };
}
