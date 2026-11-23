import test from 'node:test';
import assert from 'node:assert/strict';
import { listRepoBranches, connectAppCredentials, githubConnectConfigured, buildAuthorizeUrl, redirectUriFor, exchangeCode, listUserRepos, GithubConnectError, describeRepoReadFailure } from './user-auth.js';

const env = { GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_CLIENT_SECRET: 'sec', GITHUB_CONNECT_APP_ID: '5493269', GITHUB_CONNECT_APP_PRIVATE_KEY_B64: 'a2V5' };
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('needs the client id and secret AND the App id and its private key', () => {
  assert.equal(githubConnectConfigured(env), true);
  assert.equal(githubConnectConfigured({ ...env, GITHUB_CONNECT_APP_PRIVATE_KEY_B64: '' }), false);
  assert.equal(githubConnectConfigured({ ...env, GITHUB_CONNECT_APP_ID: '' }), false);
  assert.equal(githubConnectConfigured({ GITHUB_APP_CLIENT_ID: 'cid' }), false);
  assert.equal(githubConnectConfigured({}), false);
});

test('the connect App has its own credentials, never the shared default ones', () => {
  assert.deepEqual(connectAppCredentials(env), { appId: '5493269', privateKeyB64: 'a2V5' });
  assert.equal(connectAppCredentials({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_B64: 'x' }), null);
});

test('authorize url carries the callback and the state', () => {
  const uri = redirectUriFor('https://app.superrank.si/');
  assert.equal(uri, 'https://app.superrank.si/api/github/callback');
  const u = new URL(buildAuthorizeUrl({ redirectUri: uri, state: 'n1', env }));
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('state'), 'n1');
  assert.equal(u.searchParams.get('client_id'), 'cid');
});

test('exchangeCode returns the token and rejects an error answer', async () => {
  assert.deepEqual(await exchangeCode({ code: 'c', redirectUri: 'r', env, fetchImpl: async () => ok({ access_token: 't1' }) }), { token: 't1' });
  await assert.rejects(exchangeCode({ code: 'c', redirectUri: 'r', env, fetchImpl: async () => ok({ error: 'bad_verification_code' }) }), GithubConnectError);
  await assert.rejects(exchangeCode({ code: '', redirectUri: 'r', env }), GithubConnectError);
});

test('listUserRepos lists only what the person token returns, across installations', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push([url, opts.headers.Authorization]);
    if (url.endsWith('/user')) return ok({ login: 'yukta' });
    if (url.includes('/user/installations?')) return ok({ installations: [{ id: 1, account: { login: 'yukta' } }, { id: 2, account: { login: 'acme' } }] });
    if (url.includes('/installations/1/repositories')) return ok({ repositories: [{ owner: { login: 'yukta' }, name: 'site', full_name: 'yukta/site', default_branch: 'main', private: true }] });
    if (url.includes('/installations/2/repositories')) return ok({ repositories: [{ owner: { login: 'acme' }, name: 'blog', full_name: 'acme/blog', default_branch: 'dev', private: false }] });
    throw new Error('unexpected ' + url);
  };
  const out = await listUserRepos('USERTOKEN', { fetchImpl });
  assert.equal(out.login, 'yukta');
  assert.deepEqual(out.repos.map((r) => [r.fullName, r.installationId, r.defaultBranch]), [['acme/blog', '2', 'dev'], ['yukta/site', '1', 'main']]);
  assert.ok(calls.every(([, auth]) => auth === 'Bearer USERTOKEN'), 'every read uses the person token, never the app key');
});

test('listRepoBranches puts the default first and reads with the person token', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push(opts.headers.Authorization); return ok([{ name: 'stage' }, { name: 'main' }, { name: 'dev' }]); };
  const out = await listRepoBranches('TOK', { owner: 'acme', name: 'blog', defaultBranch: 'main' }, { fetchImpl });
  assert.deepEqual(out, [{ name: 'main', default: true }, { name: 'dev', default: false }, { name: 'stage', default: false }]);
  assert.deepEqual(seen, ['Bearer TOK']);
});

// 2026-11-23: a server with no GitHub App sign-in settings, and any GitHub error at all, both showed "Your GitHub sign-in has expired. Connect again.", which sent a
// person round in circles. Only a 401 from GitHub means the sign-in is gone.
test('a GitHub error carries its HTTP status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(listUserRepos('T', { fetchImpl }), (e) => e instanceof GithubConnectError && e.status === 403 && e.code === 'github_failed');
});

test('only a 401 means the sign-in expired, and only then is the session dropped', () => {
  const err = (status) => new GithubConnectError('github_failed', 'x', status);
  assert.deepEqual(describeRepoReadFailure(err(401)), { dropSession: true, message: 'Your GitHub sign-in has expired. Connect again.' });
  for (const status of [403, 429]) {
    const r = describeRepoReadFailure(err(status));
    assert.equal(r.dropSession, false, String(status));
    assert.match(r.message, /limiting requests.*sign-in is still good/);
  }
  for (const status of [500, 502, 503]) {
    const r = describeRepoReadFailure(err(status));
    assert.equal(r.dropSession, false, String(status));
    assert.match(r.message, /having trouble.*sign-in is still good/);
  }
});

test('anything else (a network error, an unexpected throw) keeps the sign-in and says GitHub could not be read', () => {
  for (const e of [new Error('ECONNRESET'), new GithubConnectError('exchange_failed', 'x'), null, undefined]) {
    const r = describeRepoReadFailure(e);
    assert.equal(r.dropSession, false);
    assert.match(r.message, /could not be read just now/);
  }
});

test('a message never carries the raw error text or a token', () => {
  const r = describeRepoReadFailure(new GithubConnectError('github_failed', 'GitHub installations failed (401) token=ghu_SECRET', 401));
  assert.doesNotMatch(r.message, /ghu_|token=|installations failed/);
});
