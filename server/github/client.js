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

// SHA of the tip of the site's default (production) branch — kept for
// contexts that specifically mean "production," distinct from the Action
// Center's real fork/merge base, which is always 'stage' per the company
// CI/CD guide (~/Travel/ci-cd-deployment-master-guide) regardless of what
// repo_default_branch happens to be.
export async function getDefaultBranchSha(site) {
  return getBranchSha(site, site.repo_default_branch || 'main');
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

// Opens a PR from `branch` into the site's default branch. Never merges —
// merging is always a human, on GitHub itself.
export async function openPullRequest(site, { branch, title, body }) {
  const res = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/pulls`, {
    head: branch,
    base: site.repo_default_branch || 'main',
    title,
    body,
  });
  if (!res.ok) throw new Error(`openPullRequest failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { number: data.number, url: data.html_url };
}

// Merges `head` directly into `base` — no PR object involved. Used only for
// merging into 'stage' (the company's real no-protection-rules staging
// branch, per ~/Travel/ci-cd-deployment-master-guide — a real PR isn't
// required there). Production (`main`) is never touched by this function;
// promoting stage -> main stays a fully manual, human action outside this
// platform. A 204 response means head is already merged into base (nothing
// to do) — treated as success, not an error.
export async function mergeBranch(site, { base, head, commitMessage }) {
  const res = await githubRequest(site, 'POST', `/repos/${repoPath(site)}/merges`, {
    base, head, commit_message: commitMessage,
  });
  if (res.status === 204) return { alreadyMerged: true, sha: null, htmlUrl: null };
  if (!res.ok) throw new Error(`mergeBranch failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { alreadyMerged: false, sha: data.sha, htmlUrl: data.html_url };
}

// Real-evidence read for the "Check PR Status" action — reports GitHub's own
// merged/state, never inferred locally.
export async function getPullRequest(site, prNumber) {
  const res = await githubRequest(site, 'GET', `/repos/${repoPath(site)}/pulls/${prNumber}`);
  if (!res.ok) throw new Error(`getPullRequest failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { state: data.state, merged: data.merged };
}
