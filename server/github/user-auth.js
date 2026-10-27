import crypto from 'node:crypto';

// "Connect with GitHub": the person signs in to GitHub as THEMSELVES, and what they can see there is
// exactly what they may connect. It is what makes a client-facing repository picker safe: the list is
// read with the person's own token, so it holds only repositories they have allowed the SuperRank app
// on, and an installation they do not own cannot be named. The token is used to read that list and is
// never written to the database (the caller keeps it in the person's server-side session for minutes).
//
// Needs the SuperRank GitHub App's OAuth credentials, with "Request user authorization (OAuth) during
// installation" turned on and https://<app>/api/github/callback as its callback URL.

const WEB = 'https://github.com';
const API = 'https://api.github.com';

// This App is separate from the shared default one (GITHUB_APP_ID), which existing projects depend on.
// A project connected through it records WHICH App signs for it (sites.github_app_id and the env var
// holding that App's private key, migration 154), so the agent later authenticates as this App for
// exactly those projects and every other project keeps its credential unchanged.
export const CONNECT_KEY_ENV = 'GITHUB_CONNECT_APP_PRIVATE_KEY_B64';

export function githubConnectConfigured(env = process.env) {
  return Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET && env.GITHUB_CONNECT_APP_ID && env[CONNECT_KEY_ENV]);
}

// { appId, privateKeyB64 } in the shape app-auth.js takes, or null when this App is not set up.
export function connectAppCredentials(env = process.env) {
  if (!env.GITHUB_CONNECT_APP_ID || !env[CONNECT_KEY_ENV]) return null;
  return { appId: env.GITHUB_CONNECT_APP_ID, privateKeyB64: env[CONNECT_KEY_ENV] };
}

export const newGithubNonce = () => crypto.randomBytes(24).toString('base64url');

export function redirectUriFor(origin) {
  return `${String(origin).replace(/\/$/, '')}/api/github/callback`;
}

export function buildAuthorizeUrl({ redirectUri, state, env = process.env }) {
  const q = new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, redirect_uri: redirectUri, state });
  return `${WEB}/login/oauth/authorize?${q}`;
}

export class GithubConnectError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function json(res, what) {
  if (!res.ok) throw new GithubConnectError('github_failed', `${what} failed (${res.status})`);
  return res.json();
}

export async function exchangeCode({ code, redirectUri, env = process.env, fetchImpl = fetch }) {
  if (!code) throw new GithubConnectError('exchange_failed', 'no code');
  const res = await fetchImpl(`${WEB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const data = await json(res, 'GitHub token exchange');
  if (data.error || !data.access_token) throw new GithubConnectError('exchange_failed', data.error_description || data.error || 'no token');
  return { token: data.access_token };
}

const get = (url, token, fetchImpl) => fetchImpl(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
});

// Repositories this person has allowed the SuperRank app on, in the same row shape the shared list uses
// (so choosing one saves through the same code), plus who they are on GitHub.
export async function listUserRepos(token, { fetchImpl = fetch } = {}) {
  const who = await json(await get(`${API}/user`, token, fetchImpl), 'GitHub user');
  const inst = await json(await get(`${API}/user/installations?per_page=100`, token, fetchImpl), 'GitHub installations');
  const rows = [];
  const installations = Array.isArray(inst.installations) ? inst.installations : [];
  await Promise.all(installations.map(async (installation) => {
    const account = installation.account?.login || null;
    for (let page = 1; ; page += 1) {
      const data = await json(await get(`${API}/user/installations/${installation.id}/repositories?per_page=100&page=${page}`, token, fetchImpl), 'GitHub repositories');
      const repos = data.repositories || [];
      for (const r of repos) {
        rows.push({
          owner: r.owner?.login || account, name: r.name, fullName: r.full_name,
          defaultBranch: r.default_branch || 'main', private: Boolean(r.private),
          installationId: String(installation.id), account,
        });
      }
      if (repos.length < 100) break;
    }
  }));
  return { login: who.login || null, repos: rows.sort((a, b) => a.fullName.localeCompare(b.fullName)) };
}

// The branches of one repository, read with the person's own token, so only a repository they can reach
// can be asked about. At most 300 (3 pages), the default branch first, then alphabetical.
export async function listRepoBranches(token, { owner, name, defaultBranch = null }, { fetchImpl = fetch } = {}) {
  const names = [];
  for (let page = 1; page <= 3; page += 1) {
    const data = await json(await get(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=100&page=${page}`, token, fetchImpl), 'GitHub branches');
    const batch = Array.isArray(data) ? data : [];
    for (const b of batch) names.push(b.name);
    if (batch.length < 100) break;
  }
  names.sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)));
  return names.map((n) => ({ name: n, default: n === defaultBranch }));
}
