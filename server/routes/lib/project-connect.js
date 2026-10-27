import { google } from 'googleapis';
import { getGoogleAuth } from '../../auth/google.js';
import { createAppJwt, appConfigured, getInstallationToken } from '../../github/app-auth.js';

// Self-serve connecting, for the New project flow and Account settings → Project.
//
// WHAT THIS REPLACES. Until now connecting a project meant a staff-only form
// where someone typed a Search Console property string and a numeric GA4 id by
// hand (routes/clients.js's /internal/clients/:id/connect), after separately
// asking the client to add our Google account as a user. Typing an id by hand
// is where connect goes wrong: a property that looks right but isn't, or a
// trailing slash, and the first baseline fails with "no real data".
//
// Instead, everything here LISTS what the credential can actually see and lets
// the person pick. A pick cannot be mistyped, and a property that isn't in the
// list is honest evidence the access isn't there yet — before the baseline
// runs, not after it fails.
//
// WHOSE GOOGLE ACCOUNT. Today that is the one shared platform account
// (auth/google.js's GOOGLE_OAUTH_* / service account), which is why
// listGoogleProperties takes no user: it answers "what can the platform
// already read", which is exactly what the baseline will use. Per-project
// OAuth ("Connect with Google" as the client's own consent) is the next step
// and needs its own OAuth client; this module is the seam it slots into —
// listGoogleProperties grows an auth argument and nothing above it changes.

const API_BASE = 'https://api.github.com';

// Same shape the staff route accepted, so a hand-typed property (still allowed
// for staff and for a property Google won't list) is validated identically.
export const GSC_PROPERTY_RE = /^(sc-domain:.+|https?:\/\/.+)$/;

// A domain, reduced to the bit worth comparing: no scheme, no www, no path.
export function bareDomain(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').replace(/^www\./, '')
    .replace(/\/.*$/, '').replace(/:\d+$/, '');
}

// Every Search Console property and GA4 property the platform's Google
// credential can read, as plain rows for a picker. Never throws for one API
// failing: a project can be connected to Search Console while GA4 access is
// still pending, and the UI says which half is missing rather than showing an
// error for both.
export async function listGoogleProperties({ auth = null } = {}) {
  const credentials = auth || getGoogleAuth(null);
  const [searchConsole, analytics] = await Promise.all([
    listSearchConsoleProperties(credentials),
    listAnalyticsProperties(credentials),
  ]);
  return { searchConsole, analytics };
}

async function listSearchConsoleProperties(auth) {
  try {
    const sc = google.searchconsole({ version: 'v1', auth });
    const { data } = await sc.sites.list();
    return (data.siteEntry || [])
      // A property we can only read at the restricted level cannot be used for
      // the sitemap resubmission the technical agent does, so it is listed with
      // its real permission rather than silently offered as equivalent.
      .map((s) => ({ property: s.siteUrl, permission: s.permissionLevel || null, domain: bareDomain(s.siteUrl) }))
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.property.localeCompare(b.property));
  } catch (err) {
    console.error('[project-connect] could not list Search Console properties:', err.message);
    return { error: 'Search Console could not be read with the connected Google account.' };
  }
}

// A GA4 property is named by a person ("Zunkiree Website"), so its name cannot say which site it is. Its
// WEB DATA STREAM holds the real address, which is what the picker needs for the site's logo and for matching
// a property to a project. One small call per property, so: a few at a time, an overall time limit (the picker
// must stay fast), failures just leave `domain` empty, and the answer is kept for an hour because a property's
// website address practically never changes.
const STREAM_CACHE_MS = 60 * 60 * 1000;
const STREAM_BUDGET_MS = 4000;
const streamCache = new Map(); // propertyId -> { at, domain }

export async function attachStreamDomains(admin, rows, { now = Date.now, budgetMs = STREAM_BUDGET_MS } = {}) {
  const deadline = now() + budgetMs;
  const todo = [];
  for (const row of rows) {
    const hit = streamCache.get(row.propertyId);
    if (hit && now() - hit.at < STREAM_CACHE_MS) row.domain = hit.domain;
    else todo.push(row);
  }
  let next = 0;
  const worker = async () => {
    while (next < todo.length && now() < deadline) {
      const row = todo[next++];
      try {
        const { data } = await admin.properties.dataStreams.list({ parent: `properties/${row.propertyId}`, pageSize: 10 });
        const uri = (data.dataStreams || []).map((d) => d.webStreamData?.defaultUri).find(Boolean);
        row.domain = uri ? bareDomain(uri) : null;
        streamCache.set(row.propertyId, { at: now(), domain: row.domain });
      } catch {
        row.domain = null; // not cached: a transient failure should be retried next time
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  for (const row of rows) if (row.domain === undefined) row.domain = null;
  return rows;
}

async function listAnalyticsProperties(auth) {
  try {
    const admin = google.analyticsadmin({ version: 'v1beta', auth });
    const rows = [];
    let pageToken;
    do {
      const { data } = await admin.accountSummaries.list({ pageSize: 200, pageToken });
      for (const account of data.accountSummaries || []) {
        for (const p of account.propertySummaries || []) {
          // `property` comes back as "properties/483837192"; everything
          // downstream (sites.ga4_property_id, the GA4 Data API) wants the
          // bare numeric id.
          const id = String(p.property || '').split('/').pop();
          if (/^\d+$/.test(id)) rows.push({ propertyId: id, name: p.displayName || id, account: account.displayName || null });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    await attachStreamDomains(admin, rows);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error('[project-connect] could not list GA4 properties:', err.message);
    return { error: 'Google Analytics could not be read with the connected Google account.' };
  }
}

// Which row a project's own website address points at, so the picker opens on
// the right answer instead of making someone find it. Exact domain match only —
// a near-miss suggestion on a property id is worse than no suggestion, since
// the whole point here is to stop the wrong property being chosen.
export function suggestGoogleProperties(domain, { searchConsole, analytics }) {
  const want = bareDomain(domain);
  if (!want) return { gscProperty: null, ga4PropertyId: null };
  const scRows = Array.isArray(searchConsole) ? searchConsole : [];
  const gaRows = Array.isArray(analytics) ? analytics : [];
  // A domain property (sc-domain:) covers every subdomain and protocol, so it
  // is the better default whenever both shapes exist for the same site.
  const sc = scRows.find((r) => r.domain === want && r.property.startsWith('sc-domain:')) || scRows.find((r) => r.domain === want);
  const ga = gaRows.find((r) => r.domain === want) || gaRows.find((r) => bareDomain(r.name) === want);
  return { gscProperty: sc?.property || null, ga4PropertyId: ga?.propertyId || null };
}

// ───────── GitHub ─────────

async function githubJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  // Status only — a GitHub failure body can echo App identifiers, and this
  // message reaches ordinary error handling (same rule as github/app-auth.js).
  if (!res.ok) throw new Error(`GitHub request failed (HTTP ${res.status}).`);
  return res.json();
}

// Every repo the SuperRank GitHub App can reach, across every account that
// installed it, each carrying the installation id a project needs to store.
//
// This is the fix for the real failure that made one App per client look
// necessary: an installation set to "only selected repositories" can reach
// exactly the repos it was given, so a project whose repo isn't among them
// silently has no credential at all. Listing the truth makes that visible —
// a repo that is missing here is missing because of the installation's own
// repository-access setting, and `installUrl` is where that is changed.
async function fetchGithubRepos() {
  if (!appConfigured()) {
    return { error: 'The SuperRank GitHub app is not configured on this server yet.', repos: [], installations: [] };
  }
  try {
    const jwt = createAppJwt();
    const app = await githubJson(`${API_BASE}/app`, jwt);
    const installations = await githubJson(`${API_BASE}/app/installations?per_page=100`, jwt);
    const rows = [];
    const accounts = [];
    await Promise.all((Array.isArray(installations) ? installations : []).map(async (installation) => {
      const account = installation.account?.login || null;
      accounts.push({ id: installation.id, account, repositorySelection: installation.repository_selection || null });
      let token;
      try {
        token = await getInstallationToken(String(installation.id));
      } catch (err) {
        console.error(`[project-connect] installation ${installation.id} token failed:`, err.message);
        return;
      }
      let page = 1;
      for (;;) {
        const data = await githubJson(`${API_BASE}/installation/repositories?per_page=100&page=${page}`, token);
        const repos = data.repositories || [];
        for (const repo of repos) {
          rows.push({
            owner: repo.owner?.login || account, name: repo.name, fullName: repo.full_name,
            defaultBranch: repo.default_branch || 'main', private: Boolean(repo.private),
            installationId: String(installation.id), account,
          });
        }
        if (repos.length < 100) break;
        page += 1;
      }
    }));
    return {
      repos: rows.sort((a, b) => a.fullName.localeCompare(b.fullName)),
      installations: accounts,
      // Where a client installs the app, or an existing installation's
      // repository access is widened. The App's own slug, so this is right for
      // whichever App this deploy is configured with.
      installUrl: app?.slug ? `https://github.com/apps/${app.slug}/installations/new` : null,
      appName: app?.name || app?.slug || null,
    };
  } catch (err) {
    console.error('[project-connect] could not list GitHub repos:', err.message);
    return { error: 'The repository list could not be read from GitHub right now.', repos: [], installations: [] };
  }
}

// The list is the slow part of the GitHub step (several calls to GitHub), and it is the same for
// every staff member, so it is kept for a minute and concurrent requests share one fetch. Only a
// successful list is kept; `fresh` skips it ("I just added the repository on GitHub").
const REPO_CACHE_MS = 60_000;
let repoCache = null;   // { at, value }
let repoInflight = null;
export async function listGithubRepos({ fresh = false } = {}) {
  if (!fresh && repoCache && Date.now() - repoCache.at < REPO_CACHE_MS) return repoCache.value;
  if (!repoInflight) {
    repoInflight = fetchGithubRepos()
      .then((value) => { if (!value.error) repoCache = { at: Date.now(), value }; return value; })
      .finally(() => { repoInflight = null; });
  }
  return repoInflight;
}

// What a project still needs before the agent can work on it, in the order the
// New project flow asks for it. Pure, so the wording is testable without a
// database or a network call.
export function connectionState(site) {
  const gsc = Boolean(site?.gsc_property);
  const ga4 = Boolean(site?.ga4_property_id);
  const repo = Boolean(site?.repo_owner && site?.repo_name);
  return {
    google: { connected: gsc && ga4, gscProperty: site?.gsc_property || null, ga4PropertyId: site?.ga4_property_id || null },
    github: {
      connected: repo,
      repo: repo ? `${site.repo_owner}/${site.repo_name}` : null,
      defaultBranch: site?.repo_default_branch || null,
      // Where the day's PR is opened; null means the default branch above.
      prTargetBranch: site?.pr_target_branch || null,
      techStack: site?.tech_stack || null,
      // An App installation is what lets the agent push without a per-client
      // token; a repo connected without one falls back to the shared PAT.
      installationId: site?.github_app_installation_id ? String(site.github_app_installation_id) : null,
    },
    baseline: { done: Boolean(site?.onboarded_at), runId: site?.baseline_run_id || null },
    // The one question the flow exists to answer.
    ready: gsc && ga4 && repo,
  };
}
