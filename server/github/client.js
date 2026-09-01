// The only place GitHub API access is constructed — mirrors server/auth/google.js's
// role for Google. Plain `fetch` against the REST API, no octokit/git dependency
// and no local clone: every operation here is one HTTP call, which is the
// simplest and safest shape for a single-repo, PAT-scoped pilot (see
// server/implementers/ for what calls these).

import { resolveGithubToken, githubTokenEnvVar, isFineGrainedToken } from './credentials.js';

const API_BASE = 'https://api.github.com';

// GitHub's Code Search REST API (/search/code, used by searchCodeForString
// below) silently returns zero results for a fine-grained PAT (github_pat_...)
// instead of an auth error — only a classic PAT (ghp_...) with `repo` scope
// actually works against it. Every other call in this file (Contents API,
// PRs, branches) works fine with either token type, so this is a
// search-only concern: a site can optionally set `<envVar>_SEARCH` (or the
// global GITHUB_SEARCH_PAT fallback) to a classic PAT used ONLY for search,
// while its main token stays fine-grained/least-privilege for everything
// else. Confirmed empirically: the same fine-grained token that resolves
// this repo's own Contents API calls fine returned 0 results searching
// facebook/react for the literal string "useState" — a definitely-indexed,
// definitely-present string — via GitHub's own public repo, ruling out a
// per-repo indexing or visibility explanation.
// (The credential rules themselves now live in ./credentials.js — see that
// file for why they were consolidated out of here.)

async function authHeaders(site, { forSearch = false } = {}) {
  const token = await resolveGithubToken(site, { forSearch });
  if (!token) throw new Error(`No GitHub PAT set in env var "${githubTokenEnvVar(site)}"`);
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function repoPath(site) {
  if (!site.repo_owner || !site.repo_name) throw new Error('Site has no repo_owner/repo_name configured');
  return `${site.repo_owner}/${site.repo_name}`;
}

// ─────────────────────────────────────────────────────────────────────────
// RATE LIMITING
//
// Nothing here read GitHub's rate-limit headers before this, which is how a
// single busy morning took the whole autonomous chain down: on 2026-09-01 the
// 08:00 run created ~130 drafts in one hour, exhausted the shared PAT's
// 5,000 req/hour budget, and every subsequent write came back
// `403 API rate limit exceeded for user ID 286862633`. 113 drafts were
// permanently abandoned for what was, in substance, a one-hour wait.
//
// Two distinct GitHub limits are handled here, because they signal
// differently and a check for one silently misses the other:
//
//  - the PRIMARY hourly limit: `x-ratelimit-remaining: 0`, with
//    `x-ratelimit-reset` giving the epoch second the budget refills.
//  - the SECONDARY ("abuse"/content-creation) limit: a 403 that can arrive
//    with `x-ratelimit-remaining` still well above zero, carrying
//    `retry-after` instead. Creating commits and PRs — exactly what the ship
//    path does — is what trips this one.
//
// Waiting is bounded on purpose. This runs inside a cron pass that has other
// sites to get to, so a limit that resets 50 minutes out must NOT be slept
// through; after RATE_LIMIT_MAX_RETRIES the request throws a TYPED error and
// the caller (auto-remediation.js) stops the run and leaves its drafts
// re-attemptable for the next pass, rather than burning the rest of the
// budget on writes that cannot succeed.
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

// The floor at which callers should stop starting NEW work. Not enforced
// here — a request already in flight is always allowed through, since
// abandoning a half-finished batch mid-write is worse than spending the last
// of the budget finishing it. See getLastKnownRateLimit below.
export const RATE_LIMIT_RESERVE = 100;

// Last rate-limit state GitHub reported, from whichever call saw it most
// recently. Module-level because it is a property of the TOKEN's budget, not
// of any one request, and every call in this file shares that budget.
// `remaining: null` means no authenticated call has been made yet this
// process — never treated as "plenty left".
let lastRateLimit = { remaining: null, reset: null, at: null };

// `res.headers.get()` returns null for a header that isn't there, and
// `Number(null)` is 0 — NOT NaN. A `Number.isFinite` guard therefore does
// NOT catch a missing header; it records "0 requests left" and latches the
// budget to permanently-exhausted for the life of the process, stopping
// every site's run without a single real rate limit. Same trap in
// rateLimitWaitMs, where it would make `isPrimary` true for any 403 lacking
// the header — misreporting a permanent "not accessible by this token" 403
// as retryable forever. Read through this helper, never Number() directly.
function headerNumber(res, name) {
  const raw = res.headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * @returns {{remaining: number|null, reset: Date|null, at: Date|null, low: boolean}}
 * `low` is the caller-facing question — "should I stop starting new work?" —
 * answered conservatively: unknown remaining reads as NOT low (nothing has
 * failed yet, so don't pre-emptively halt a healthy run), but any observed
 * value under the reserve does.
 */
export function getLastKnownRateLimit() {
  // `low` MUST expire. The budget refills at `reset`, but nothing re-reads it
  // on its own: auto-remediation's pre-check breaks the loop BEFORE making any
  // GitHub call, so a run that starts low makes zero requests, learns nothing,
  // and leaves this state stale for the next run to trip over identically.
  // Once latched, the autonomous loop could never recover from within itself.
  // A reset that has already passed means the observation is simply out of
  // date — report not-low and let the next real response say what's true.
  const expired = lastRateLimit.reset != null && lastRateLimit.reset.getTime() <= Date.now();
  return {
    ...lastRateLimit,
    low: !expired && lastRateLimit.remaining != null && lastRateLimit.remaining < RATE_LIMIT_RESERVE,
  };
}

// `forSearch` responses are deliberately NOT recorded. GitHub's rate limits
// are per-RESOURCE, and /search/code has its own budget of about 30 per
// minute against core's 5,000 per hour. Recording a search response's
// `x-ratelimit-remaining: 29` as though it described the core budget puts it
// instantly under RATE_LIMIT_RESERVE (100) — and since searchCodeForString
// sits directly on the ship path (backend.js's marker discovery,
// discover-file-mapping.js's auto-heal), the very first item of a run would
// leave every subsequent item's pre-check reading "low" and halt the run
// after one ship. Tracking core only keeps this state meaning one thing.
function recordRateLimitHeaders(res, { forSearch = false } = {}) {
  if (forSearch) return;
  const remaining = headerNumber(res, 'x-ratelimit-remaining');
  if (remaining === null) return;
  const reset = headerNumber(res, 'x-ratelimit-reset');
  lastRateLimit = {
    remaining,
    reset: reset === null ? null : new Date(reset * 1000),
    at: new Date(),
  };
}

// How long to wait before retrying, or null if this response is not a rate
// limit at all. The body is read from a CLONE so the caller's own
// `await res.text()` still works — every caller in this file reads the body
// of a failed response to build its error message, and consuming it here
// would turn a rate limit into an empty-message mystery.
async function rateLimitWaitMs(res) {
  if (res.status !== 403 && res.status !== 429) return null;

  const retryAfter = headerNumber(res, 'retry-after');
  const remaining = headerNumber(res, 'x-ratelimit-remaining');
  const reset = headerNumber(res, 'x-ratelimit-reset');

  // Header evidence first — it is unambiguous and costs nothing. A 403 with
  // neither signal is checked against the body, because a secondary limit
  // can arrive with no rate-limit header at all; a 403 that is genuinely
  // "this token cannot write to this repo" must NOT be retried, and the body
  // is the only thing that separates the two.
  const isPrimary = remaining === 0;
  const hasRetryAfter = retryAfter !== null && retryAfter > 0;
  if (!isPrimary && !hasRetryAfter) {
    const body = await res.clone().text().catch(() => '');
    if (!/rate limit|secondary rate|abuse detection/i.test(body)) return null;
  }

  const waitMs = hasRetryAfter
    ? retryAfter * 1000
    : (reset === null ? RATE_LIMIT_MAX_WAIT_MS : reset * 1000 - Date.now());
  // Clamped at both ends: never a busy-loop on a stale/absent reset, never
  // longer than one cron pass can afford to sit still.
  return Math.min(Math.max(waitMs, 1_000), RATE_LIMIT_MAX_WAIT_MS);
}

// Typed so callers can tell a wait-and-it-works failure from a permanent one
// WITHOUT regex-matching a provider message that changes without notice —
// see lib/failure-classification.js, which maps `rateLimited` onto its
// EXTERNAL_SERVICE class (the one class it treats as auto-retryable).
function rateLimitError(path, waitMs) {
  const reset = lastRateLimit.reset;
  const err = new Error(
    `GitHub rate limit reached for ${path}${reset ? ` (resets ${reset.toISOString()})` : ''} — `
    + `retried ${RATE_LIMIT_MAX_RETRIES}x, still limited.`,
  );
  err.rateLimited = true;
  err.retryAfterMs = waitMs;
  err.rateLimitReset = reset;
  return err;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function githubRequest(site, method, path, body, { forSearch = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { ...(await authHeaders(site, { forSearch })), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    recordRateLimitHeaders(res, { forSearch });

    const waitMs = await rateLimitWaitMs(res);
    if (waitMs == null) return res;
    if (attempt >= RATE_LIMIT_MAX_RETRIES) throw rateLimitError(path, waitMs);

    console.warn(`[github] rate limited on ${method} ${path}; waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`);
    await sleep(waitMs);
  }
}

// SHA of the tip of an arbitrary real branch.
export async function getBranchSha(site, branch) {
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/git/ref/heads/${branch}`);
  if (!res.ok) throw new Error(`getBranchSha failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.object.sha;
}

// This site's default (production) branch name — the single source of
// truth every other function here and in implementers/lib/github-ops.js
// uses instead of each inlining its own `site.repo_default_branch || 'main'`
// fallback.
export function defaultBranchName(site) {
  return site.repo_default_branch || 'main';
}

// SHA of the tip of the site's default (production) branch.
export async function getDefaultBranchSha(site) {
  return getBranchSha(site, defaultBranchName(site));
}

// When this site's PAT expires, as a Date — or null if it never does (classic
// PATs, and fine-grained ones created with no expiry) or GitHub didn't say.
//
// GitHub returns the token's own expiry on every authenticated response, in the
// `github-authentication-token-expiration` header. Nothing here read it, which
// meant a token one day from expiry looked exactly as healthy as a fresh one —
// and expiry is not a hypothetical failure mode: site 1's PAT expired between
// 2026-08-11 and 2026-08-12, the autonomous chain stopped opening PRs, and
// nothing noticed for two days because every surface only ever asked "does it
// work right now".
//
// A dead token throws (401 -> the caller's own error handling); this is
// deliberately for the "still working, but for how long" question only.
export async function getTokenExpiry(site) {
  const res = await githubRequest(site, 'GET', '/user');
  if (!res.ok) throw new Error(`Token check failed (${res.status})`);
  const raw = res.headers.get('github-authentication-token-expiration');
  if (!raw) return null;
  // Observed format is "2026-11-13 14:30:00 UTC"; ISO-8601 also parses. Both
  // are normalized here rather than at call sites, and an unparseable value
  // reports null (unknown) rather than a wrong date.
  const parsed = new Date(raw.trim().replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Creates `refs/heads/<branchName>` pointing at fromSha. A 422 "Reference
// already exists" is treated as success (not an error) — apply() is safe to
// retry against a branch a prior attempt already created, matching this
// codebase's existing idempotent-write convention (§18).
export async function createBranch(site, branchName, fromSha) {
  const res = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  });
  if (res.ok) return true;
  const body = await res.text();
  if (res.status === 422 && /already exists/i.test(body)) return true;
  throw new Error(`createBranch failed (${res.status}): ${body}`);
}

// Batch write-overlay (Action Center same-day batching, see github-ops.js's
// beginBatchPush/endBatchPush). While a batch is active for (site, branch),
// every commit created for it is chained locally WITHOUT moving the real
// branch ref until the whole batch finishes — one push instead of one per
// recommendation. But dozens of implementers read "what's currently on this
// branch" via getFileContent/getFileSha (marker-merge splices, the
// family-write-marker check) to decide how to merge the NEXT change in. Left
// alone, every read after the batch's first commit would see stale,
// pre-batch content — since the real ref hasn't moved — silently producing
// wrong merges, not just a missing feature. This overlay is what keeps those
// reads accurate: a write recorded here is what a same-branch read sees,
// even though GitHub itself hasn't been told about it yet.
const fileOverlays = new Map(); // key: `${site.id}:${branch}` -> Map<path, {content, sha}|null>

function overlayKey(site, branch) {
  return `${site.id}:${branch}`;
}

export function beginFileOverlay(site, branch) {
  fileOverlays.set(overlayKey(site, branch), new Map());
}

export function endFileOverlay(site, branch) {
  fileOverlays.delete(overlayKey(site, branch));
}

function getFileOverlay(site, branch) {
  return fileOverlays.get(overlayKey(site, branch)) || null;
}

// Records what a just-created (not-yet-pushed) batch commit actually wrote,
// so a later read on the same branch sees it. `sha: null` is deliberate —
// files here are always written via the tree API's inline `content` (see
// createCommitObject below), which never needs a blob sha to build the NEXT
// tree on top of it; only putFile's create-vs-update check reads
// getFileSha's return, and putFile is never used against an actively-
// batching branch (confirmed: no call site in server/implementers/).
export function recordFileOverlayWrites(site, branch, files) {
  const overlay = getFileOverlay(site, branch);
  if (!overlay) return;
  for (const f of files) overlay.set(f.path, { content: f.content, sha: null });
}

// Current blob SHA of a file on a given ref, or null if it doesn't exist yet
// (a brand-new file, e.g. a new landing page) — putFile needs this to decide
// create vs. update.
export async function getFileSha(site, path, ref) {
  const overlay = getFileOverlay(site, ref);
  if (overlay?.has(path)) return overlay.get(path)?.sha ?? null;
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getFileSha failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.sha;
}

// Real current content + blob SHA of a file on a given ref — the read half
// of a real merge (see implementers/lib/marker-merge.js): a marker-based
// splice needs the file's actual live text, not just its SHA, to find the
// real marker comments and confirm they're really there before writing
// anything. Returns null if the file doesn't exist on this ref.
export async function getFileContent(site, path, ref) {
  const overlay = getFileOverlay(site, ref);
  if (overlay?.has(path)) return overlay.get(path);
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getFileContent failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
}

// Creates or updates one file on `branch`. `sha` must be the file's current
// blob SHA when updating an existing file (omit/null for a brand-new file) —
// GitHub's contents API rejects an update without it.
export async function putFile(site, { path, content, message, branch, sha }) {
  const res = await githubRequest(site, 'PUT', `/repos/${repoPath(site)}/contents/${path}`, {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
  if (!res.ok) throw new Error(`putFile failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Merges `base`'s current tip INTO `branch` (GitHub's server-side merge
// endpoint, not a PR) — used by getOrInitBatchBranch (implementers/lib/
// github-ops.js) to keep a shared per-day batch branch continuously in sync
// with the site's default branch throughout the day, instead of forking it
// once in the morning and letting it silently drift while more drafts land
// on it. Three real outcomes: 201 (merge commit created, branch now current),
// 204 (branch already contains base's tip, nothing to do), 409 (real merge
// conflict — cannot auto-sync, caller must surface this rather than splice
// against stale content). This is the ONE place this app ever merges two
// branches together outside of a human's own "Merge pull request" click on
// GitHub — it only ever merges FROM the trusted default branch INTO a
// disposable, not-yet-reviewed batch branch, never the other direction.
export async function mergeBranchFromBase(site, branch, base) {
  const res = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/merges`, {
    base: branch,
    head: base,
    commit_message: `Sync ${branch} with ${base}`,
  });
  if (res.status === 204) return { ok: true, conflicted: false, synced: false };
  if (res.status === 201) return { ok: true, conflicted: false, synced: true };
  if (res.status === 409) return { ok: false, conflicted: true };
  throw new Error(`mergeBranchFromBase failed (${res.status}): ${await res.text()}`);
}

// Atomically writes N files to `branch` as ONE commit via the Git Data API
// (tree -> commit -> ref update) instead of N sequential Contents-API PUTs.
// Used in place of a putFile-per-file loop specifically for multi-file
// draft types (llms-txt+robots.txt, broken-link-fix's multi-page strip) — a
// real incident showed the sequential-loop approach can leave an earlier
// file's commit permanently stranded on a shared batch branch, owned by no
// draft, if a LATER file in the same loop fails (stale SHA, transient
// GitHub 5xx). This way it's genuinely all-or-nothing: either every file
// lands in one commit, or the ref never moves and nothing changed. Tree
// entries take `content` directly (GitHub creates the blob for you) — no
// per-file SHA lookup needed first, unlike putFile, since a tree diff
// against `base_tree` handles create vs. update either way.
// Creates a commit object on top of `parentSha`'s tree — WITHOUT moving any
// branch ref. Split out of commitFilesAtomic (below) specifically for
// Action Center batching: github-ops.js's deferred mode chains several of
// these locally (each one's parent is the previous one's sha, not yet
// pointed to by any ref) and only moves the ref once, at the end, via
// updateRef — so GitHub (and therefore Vercel's per-push preview build)
// only sees the branch move once per batch, not once per commit.
export async function createCommitObject(site, parentSha, files, message) {
  const commitRes = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/git/commits/${parentSha}`);
  if (!commitRes.ok) throw new Error(`createCommitObject (read commit) failed (${commitRes.status}): ${await commitRes.text()}`);
  const baseTree = (await commitRes.json()).tree.sha;

  const treeRes = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/git/trees`, {
    base_tree: baseTree,
    tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
  });
  if (!treeRes.ok) throw new Error(`createCommitObject (create tree) failed (${treeRes.status}): ${await treeRes.text()}`);
  const newTree = (await treeRes.json()).sha;

  const newCommitRes = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/git/commits`, {
    message, tree: newTree, parents: [parentSha],
  });
  if (!newCommitRes.ok) throw new Error(`createCommitObject (create commit) failed (${newCommitRes.status}): ${await newCommitRes.text()}`);
  return (await newCommitRes.json()).sha;
}

// Moves `branch`'s ref to point at `sha` — the actual "push" GitHub (and
// Vercel's GitHub integration) sees as a new event. Split out so a caller
// batching several createCommitObject calls can do this exactly once, for
// the whole batch, instead of once per commit.
export async function updateRef(site, branch, sha) {
  const res = await githubRequest(site, 'PATCH', `/repos/${repoPath(site)}/git/refs/heads/${branch}`, { sha });
  if (!res.ok) throw new Error(`updateRef failed (${res.status}): ${await res.text()}`);
}

// Atomically writes N files to `branch` as one commit AND pushes it
// immediately (tree -> commit -> ref update) — the original, single-call
// shape every non-batching caller (rollback, platform self-repair scripts,
// a human's single-click "ship this one" draft) still uses unchanged.
export async function commitFilesAtomic(site, branch, files, message) {
  const refSha = await getBranchSha(site, branch);
  const newCommitSha = await createCommitObject(site, refSha, files, message);
  await updateRef(site, branch, newCommitSha);
  return { sha: newCommitSha };
}

// Opens a PR from `branch` into the site's default branch. Never merges —
// merging is always a human, on GitHub itself.
export async function openPullRequest(site, { branch, title, body }) {
  const res = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/pulls`, {
    head: branch,
    base: defaultBranchName(site),
    title,
    body,
  });
  if (!res.ok) throw new Error(`openPullRequest failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { number: data.number, url: data.html_url };
}

// Real-evidence read for the "Check PR Status" action — reports GitHub's own
// merged/state, never inferred locally. Also surfaces GitHub's own
// mergeable/mergeable_state (previously discarded here) — the only signal
// this app has for "this PR can no longer auto-merge" (a batch branch that's
// gone stale/conflicted relative to the default branch) without a human
// having to open the PR on GitHub and see the red banner themselves.
// `mergeable` is null immediately after a push while GitHub computes it in
// the background — real-not-yet-known, not "not conflicted."
export async function getPullRequest(site, prNumber) {
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/pulls/${prNumber}`);
  if (!res.ok) throw new Error(`getPullRequest failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { state: data.state, merged: data.merged, mergeable: data.mergeable, mergeableState: data.mergeable_state };
}

// Full recursive file listing of a branch's tree — the one real inventory of
// "every file that actually exists in this repo," used by
// implementers/lib/discover-file-mapping.js to find a url_file_map candidate
// by real filename instead of guessing from framework convention. GitHub
// truncates the response (silently, via `truncated: true`) past ~100,000
// entries/7MB — surfaced to the caller rather than swallowed, since a
// truncated listing can produce false "no candidate found" results.
export async function getRepoTree(site, branch) {
  const sha = await getBranchSha(site, branch);
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/git/trees/${sha}?recursive=1`);
  if (!res.ok) throw new Error(`getRepoTree failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const files = (data.tree || []).filter((entry) => entry.type === 'blob').map((entry) => entry.path);
  return { files, truncated: !!data.truncated };
}

// Real full-repo snapshot as gzipped tar bytes, at `ref` (defaults to the
// site's own default branch) — GitHub's tarball endpoint, still one
// authenticated REST call like everything else in this file (fetch follows
// the redirect to codeload.github.com itself; no git binary, no PAT ever
// touches a URL or a cloned .git directory). Used by
// server/design-agent/repo-checkout.js to give the Design Agent's isolated
// Docker workspace a real, complete copy of the tenant's actual repo instead
// of one page's rendered HTML — the only consumer that needs more than a
// handful of individual files, so it's the one caller of this rather than
// looping getFileContent over getRepoTree's file list.
export async function getRepoTarball(site, ref) {
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/tarball/${encodeURIComponent(ref || defaultBranchName(site))}`);
  if (!res.ok) throw new Error(`getRepoTarball failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Last-resort candidate finder for broken-link-fix's Layer 2 (see
// implementers/backend.js's computeBrokenLinkFixMerge) — locates files by
// literal content match via GitHub's Code Search API, when url_file_map has
// no entry (or no anchor match) for any of a finding's known source pages.
// This is fundamentally different from url-file-map.js's resolveFile: it
// finds a file by REAL, literal content, not by guessing a path from
// framework convention — but it's still only a candidate list. Callers MUST
// re-verify each result with a real regex match (href-rewrite-inject.js's
// stripLink) before touching anything; search relevance is never trusted
// alone.
//
// Caveat: GitHub's code search only indexes the repo's DEFAULT branch and
// files under ~384KB, and has its own, stricter rate limit than the
// Contents API used elsewhere in this file — call this only as a genuine
// last resort, never speculatively. If the working ref isn't actually this
// repo's default branch, results may miss files that exist there but
// haven't been indexed yet.
export async function searchCodeForString(site, literal, { maxResults = 5 } = {}) {
  const envVar = githubTokenEnvVar(site);
  const token = await resolveGithubToken(site, { forSearch: true });
  if (isFineGrainedToken(token)) {
    throw new Error(
      `Code search would silently return 0 results with a fine-grained PAT — set ` +
      `${envVar}_SEARCH (or the global GITHUB_SEARCH_PAT) to a classic PAT with ` +
      `"repo" scope to enable it.`
    );
  }
  const q = `"${literal}" repo:${repoPath(site)}`;
  const res = await githubRequest(site, 'GET', `/search/code?q=${encodeURIComponent(q)}&per_page=${maxResults}`, undefined, { forSearch: true });
  if (!res.ok) throw new Error(`searchCodeForString failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const paths = (data.items || []).map((item) => item.path);
  return [...new Set(paths)].slice(0, maxResults);
}

// GitHub Check Runs for a real commit/ref — the read half of the Rendering
// Validation Gate's Phase 2 (implementers/lib/rendering-gate.js's
// checkClientBuildStatus): a client repo's own "rendering-validation"
// GitHub Actions job (installed via scripts/install-rendering-workflow.js)
// reports its result here, and this app reads it back rather than trusting
// a locally-run build it never actually performed.
export async function getCheckRunsForRef(site, ref) {
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/commits/${encodeURIComponent(ref)}/check-runs`);
  if (!res.ok) throw new Error(`getCheckRunsForRef failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.check_runs || []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
}

// Lists open PRs whose head is exactly `branch` — used to detect "does
// today's batch branch already have a PR open" before trying to open a new
// one, since GitHub 422s on a second PR for the same head->base pair.
export async function listOpenPullRequestsForBranch(site, branch) {
  const owner = repoPath(site).split('/')[0];
  const head = `${owner}:${branch}`;
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/pulls?state=open&head=${encodeURIComponent(head)}`);
  if (!res.ok) throw new Error(`listOpenPullRequestsForBranch failed (${res.status}): ${await res.text()}`);
  return res.json();
}
