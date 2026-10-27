import test from 'node:test';
import assert from 'node:assert/strict';
import { listRepoBranches, connectAppCredentials, githubConnectConfigured, buildAuthorizeUrl, redirectUriFor, exchangeCode, listUserRepos, GithubConnectError } from './user-auth.js';

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
