import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let appIsConfigured = true;
let mintedFor = [];
let appConfiguredCalls = [];
let mintedWithCredentials = [];

mock.module(resolve('./app-auth.js'), {
  namedExports: {
    appConfigured: (credentials) => { appConfiguredCalls.push(credentials); return appIsConfigured; },
    getInstallationToken: async (id, opts) => {
      mintedFor.push(id);
      mintedWithCredentials.push(opts?.credentials ?? null);
      return `ghs_for_${id}`;
    },
  },
});

const { resolveGithubToken, githubTokenEnvVar, usesGithubApp } = await import('./credentials.js');

const saved = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
}

beforeEach(() => {
  appIsConfigured = true;
  mintedFor = [];
  appConfiguredCalls = [];
  mintedWithCredentials = [];
  setEnv({
    GITHUB_PAT: 'pat_shared_default',
    TENANT_B_PAT: 'pat_tenant_b',
    GITHUB_SEARCH_PAT: null,
    GITHUB_PAT_SEARCH: null,
  });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const patSite = { id: 1, github_pat_env_var: 'GITHUB_PAT' };
const perTenantPatSite = { id: 2, github_pat_env_var: 'TENANT_B_PAT' };
const appSite = { id: 3, github_app_installation_id: 777 };
const ownAppSite = {
  id: 4,
  github_app_installation_id: 888,
  github_app_id: 999,
  github_app_private_key_env_var: 'GITHUB_APP_PRIVATE_KEY_B64_TENANT_C',
};

describe('githubTokenEnvVar', () => {
  test('is per-site, defaulting to GITHUB_PAT rather than hardcoding it', () => {
    assert.equal(githubTokenEnvVar(patSite), 'GITHUB_PAT');
    assert.equal(githubTokenEnvVar(perTenantPatSite), 'TENANT_B_PAT');
    assert.equal(githubTokenEnvVar({}), 'GITHUB_PAT');
    assert.equal(githubTokenEnvVar(undefined), 'GITHUB_PAT');
  });
});

describe('resolveGithubToken — PAT path', () => {
  test('resolves each site through its own env var', async () => {
    assert.equal(await resolveGithubToken(patSite), 'pat_shared_default');
    assert.equal(await resolveGithubToken(perTenantPatSite), 'pat_tenant_b');
  });

  test('returns null, rather than throwing, when nothing is configured', async () => {
    setEnv({ GITHUB_PAT: null });
    assert.equal(await resolveGithubToken(patSite), null);
  });
});

describe('resolveGithubToken — GitHub App path', () => {
  test('mints an installation token for a site that has an installation', async () => {
    assert.equal(await resolveGithubToken(appSite), 'ghs_for_777');
    assert.deepEqual(mintedFor, [777]);
  });

  test('never touches the PAT env for an App site', async () => {
    const token = await resolveGithubToken(appSite);
    assert.notEqual(token, 'pat_shared_default');
  });

  // THE security property of this module. github_pat_env_var defaults to the
  // shared GITHUB_PAT, so falling back when the App is unavailable would let a
  // misconfigured deploy authenticate tenant B's repository with tenant A's
  // credential. A missing credential is loud and recoverable; the wrong
  // tenant's is neither.
  test('returns null — NOT the shared PAT — when the App is unconfigured', async () => {
    appIsConfigured = false;
    const token = await resolveGithubToken(appSite);

    assert.equal(token, null);
    assert.notEqual(token, 'pat_shared_default', 'must never silently fall back to another tenant\'s credential');
    assert.deepEqual(mintedFor, []);
  });

  test('installation id 0 is still an installation, not "unset"', async () => {
    // != null rather than a truthiness check: GitHub ids are positive in
    // practice, but a truthiness test would silently route id 0 to the PAT path.
    assert.equal(usesGithubApp({ github_app_installation_id: 0 }), true);
    assert.equal(usesGithubApp({ github_app_installation_id: null }), false);
    assert.equal(usesGithubApp({}), false);
  });
});

describe('resolveGithubToken — per-client App path (migration 154)', () => {
  test('a site with its own App id passes its own credentials through, not the shared default', async () => {
    setEnv({ GITHUB_APP_PRIVATE_KEY_B64_TENANT_C: 'a2V5LW1hdGVyaWFs' });

    const token = await resolveGithubToken(ownAppSite);

    assert.equal(token, 'ghs_for_888');
    assert.deepEqual(appConfiguredCalls, [{ appId: 999, privateKeyB64: 'a2V5LW1hdGVyaWFs' }]);
    assert.deepEqual(mintedWithCredentials, [{ appId: 999, privateKeyB64: 'a2V5LW1hdGVyaWFs' }]);
  });

  test('a site with no github_app_id passes null credentials — uses the shared default App', async () => {
    await resolveGithubToken(appSite);
    assert.deepEqual(appConfiguredCalls, [null]);
    assert.deepEqual(mintedWithCredentials, [null]);
  });

  // The whole point: a site that declared its own App must never sign with
  // the shared default App's key against its own (different) App id — that
  // fails confusingly at GitHub instead of here. So a missing key env var
  // must NOT fall back to using the global default key with this site's id.
  test('a site with its own App id but a missing key env var reports unconfigured, never mixes in the default key', async () => {
    setEnv({ GITHUB_APP_PRIVATE_KEY_B64_TENANT_C: null, GITHUB_APP_PRIVATE_KEY_B64: 'ZGVmYXVsdC1rZXk=' });
    // appConfigured is mocked in this file, so drive it the way the real one
    // (app-auth.test.js) actually behaves for a null privateKeyB64: unconfigured.
    appIsConfigured = false;

    const token = await resolveGithubToken(ownAppSite);

    assert.deepEqual(appConfiguredCalls, [{ appId: 999, privateKeyB64: null }]);
    assert.equal(token, null, 'must return null rather than mint with someone else\'s key');
    assert.deepEqual(mintedFor, [], 'must never even attempt to mint with mismatched credentials');
  });
});

describe('resolveGithubToken — code search', () => {
  // GitHub's /search/code returns ZERO RESULTS rather than an auth error for a
  // fine-grained PAT, and an installation token is no better. Silently-zero is
  // the worst failure available here, because the caller treats "no matches" as
  // a real answer — so search only ever uses a token explicitly designated for
  // it.
  test('never uses an App installation token', async () => {
    assert.equal(await resolveGithubToken(appSite, { forSearch: true }), null);
    assert.deepEqual(mintedFor, [], 'must not even mint one');
  });

  test('never falls back to the ordinary PAT', async () => {
    assert.equal(await resolveGithubToken(patSite, { forSearch: true }), null);
  });

  test('uses the per-site search token, then the global one', async () => {
    setEnv({ GITHUB_SEARCH_PAT: 'ghp_global_search' });
    assert.equal(await resolveGithubToken(patSite, { forSearch: true }), 'ghp_global_search');

    setEnv({ GITHUB_PAT_SEARCH: 'ghp_site_search' });
    assert.equal(await resolveGithubToken(patSite, { forSearch: true }), 'ghp_site_search');
  });
});
