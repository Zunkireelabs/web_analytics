// The only place GitHub API access is constructed — mirrors server/auth/google.js's
// role for Google. Plain `fetch` against the REST API, no octokit/git dependency
// and no local clone: every operation here is one HTTP call, which is the
// simplest and safest shape for a single-repo, PAT-scoped pilot (see
// server/implementers/ for what calls these).

const API_BASE = 'https://api.github.com';

function authHeaders(site) {
  const envVar = site.github_pat_env_var || 'GITHUB_PAT';
  const token = process.env[envVar];
  if (!token) throw new Error(`No GitHub PAT set in env var "${envVar}"`);
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

async function githubRequest(site, method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { ...authHeaders(site), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
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

// Current blob SHA of a file on a given ref, or null if it doesn't exist yet
// (a brand-new file, e.g. a new landing page) — putFile needs this to decide
// create vs. update.
export async function getFileSha(site, path, ref) {
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
export async function commitFilesAtomic(site, branch, files, message) {
  const refSha = await getBranchSha(site, branch);

  const commitRes = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/git/commits/${refSha}`);
  if (!commitRes.ok) throw new Error(`commitFilesAtomic (read commit) failed (${commitRes.status}): ${await commitRes.text()}`);
  const baseTree = (await commitRes.json()).tree.sha;

  const treeRes = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/git/trees`, {
    base_tree: baseTree,
    tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
  });
  if (!treeRes.ok) throw new Error(`commitFilesAtomic (create tree) failed (${treeRes.status}): ${await treeRes.text()}`);
  const newTree = (await treeRes.json()).sha;

  const newCommitRes = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/git/commits`, {
    message, tree: newTree, parents: [refSha],
  });
  if (!newCommitRes.ok) throw new Error(`commitFilesAtomic (create commit) failed (${newCommitRes.status}): ${await newCommitRes.text()}`);
  const newCommitSha = (await newCommitRes.json()).sha;

  const updateRefRes = await githubRequest(site, 'PATCH', `/repos/${repoPath(site)}/git/refs/heads/${branch}`, { sha: newCommitSha });
  if (!updateRefRes.ok) throw new Error(`commitFilesAtomic (update ref) failed (${updateRefRes.status}): ${await updateRefRes.text()}`);

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
  const q = `"${literal}" repo:${repoPath(site)}`;
  const res = await githubRequest(site, 'GET', `/search/code?q=${encodeURIComponent(q)}&per_page=${maxResults}`);
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
