import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  posthogConnectConfigured, clientIdFor, redirectUriFor, clientMetadataDocument, resolveHost, newCodeVerifier, codeChallengeFor, buildConsentUrl,
  exchangeCode, refreshAccessToken, revokeToken, listProjects, PosthogConnectError, SCOPES, validatePosthogHost, hostGuard, forgetHostChecks,
} from './posthog-connect.js';

// Shapes below are PostHog's real ones: the token response is the one in PostHog's OAuth development guide
// (https://posthog.com/handbook/engineering/oauth-development-guide) and the metadata rules are the CIMD rules in
// https://posthog.com/docs/api/oauth. A fake that is merely convenient proves nothing about a real PostHog.

const ORIGIN = 'https://app.superrank.si';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const REAL_TOKEN_RESPONSE = {
  access_token: 'pha_access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'phr_refresh', id_token: 'jwt',
  scope: 'openid email query:read project:read', scoped_teams: [1, 2], scoped_organizations: ['org-uuid'],
};

describe('this client\'s identity (Client ID Metadata Document)', () => {
  test('the client_id is a URL on our own domain, and the document repeats it character for character', () => {
    const doc = clientMetadataDocument(ORIGIN);
    assert.equal(doc.client_id, `${ORIGIN}/api/posthog/oauth-client`);
    assert.equal(doc.client_id, clientIdFor(ORIGIN));
  });

  test('it satisfies PostHog\'s rules: https client_id with a path and no query, no "PostHog" in the name, public client, exact redirect', () => {
    const doc = clientMetadataDocument(ORIGIN);
    const u = new URL(doc.client_id);
    assert.equal(u.protocol, 'https:'); assert.ok(u.pathname.length > 1); assert.equal(u.search, ''); assert.equal(u.hash, '');
    assert.ok(!/post\W*hog|official|verified|trusted/i.test(doc.client_name), 'PostHog rejects these names');
    assert.equal(doc.token_endpoint_auth_method, 'none');
    assert.deepEqual(doc.redirect_uris, [`${ORIGIN}/api/posthog/callback`]);
    assert.ok(Buffer.byteLength(JSON.stringify(doc)) < 5 * 1024, 'PostHog refuses a document over 5 KB');
  });

  test('read-only: the scope ceiling and the request carry no write scope', () => {
    const doc = clientMetadataDocument(ORIGIN);
    assert.deepEqual(doc['com.posthog'].scopes, ['query:read', 'project:read']);
    for (const s of [...SCOPES, ...doc.scope.split(' ')]) assert.ok(!/write|\*/.test(s), `${s} must not be a write scope`);
  });

  test('environment overrides win (needed behind a proxy that hides the public address)', () => {
    const env = { POSTHOG_OAUTH_CLIENT_ID: 'https://x.example/oc', POSTHOG_OAUTH_REDIRECT_URI: 'https://x.example/cb' };
    assert.equal(clientIdFor(ORIGIN, env), 'https://x.example/oc');
    assert.equal(redirectUriFor(ORIGIN, env), 'https://x.example/cb');
  });

  test('"not configured" on localhost and plain http (PostHog cannot fetch them) instead of failing mid-flow', () => {
    assert.equal(posthogConnectConfigured(ORIGIN, {}), true);
    assert.equal(posthogConnectConfigured('http://localhost:5174', {}), false);
    assert.equal(posthogConnectConfigured('http://app.superrank.si', {}), false);
    assert.equal(posthogConnectConfigured('https://127.0.0.1', {}), false);
    assert.equal(posthogConnectConfigured('not a url', {}), false);
    assert.equal(posthogConnectConfigured('http://localhost:5174', { POSTHOG_OAUTH_CLIENT_ID: 'https://app.superrank.si/api/posthog/oauth-client' }), true);
  });
});

describe('where PostHog lives', () => {
  const publicDns = async () => [{ address: '203.0.113.7', family: 4 }];
  test('us and eu are fixed, and the default is the US cloud', async () => {
    assert.equal(await resolveHost({}), 'https://us.posthog.com');
    assert.equal(await resolveHost({ region: 'us' }), 'https://us.posthog.com');
    assert.equal(await resolveHost({ region: 'eu' }), 'https://eu.posthog.com');
  });

  test('a self-hosted address is normalised, and must be https', async () => {
    assert.equal(await resolveHost({ region: 'self', host: 'ph.example.com/' }, { lookup: publicDns }), 'https://ph.example.com');
    await assert.rejects(() => resolveHost({ region: 'self', host: 'http://ph.example.com' }, { lookup: publicDns }), (e) => e instanceof PosthogConnectError && e.code === 'bad_host');
    await assert.rejects(() => resolveHost({ region: 'self', host: '' }), (e) => e.code === 'bad_host');
  });

  test('an address that would make this server call an internal network is refused, including by what the NAME resolves to', async () => {
    for (const host of ['https://localhost', 'https://127.0.0.1', 'https://10.0.0.5', 'https://192.168.1.2', 'https://169.254.169.254', 'https://[::1]', 'https://user:pw@ph.example.com']) {
      await assert.rejects(() => resolveHost({ region: 'self', host }, { lookup: publicDns }), (e) => e.code === 'bad_host', host);
    }
    const sneaky = async () => [{ address: '10.1.2.3', family: 4 }];
    await assert.rejects(() => resolveHost({ region: 'self', host: 'https://innocent.example.com' }, { lookup: sneaky }), (e) => e.code === 'bad_host');
    const failing = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(() => resolveHost({ region: 'self', host: 'https://nope.example.com' }, { lookup: failing }), (e) => e.code === 'bad_host');
  });
});

describe('PKCE and the consent address', () => {
  test('the challenge is the S256 hash of the verifier (RFC 7636 appendix B vector)', () => {
    assert.equal(codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const v = newCodeVerifier();
    assert.equal(codeChallengeFor(v), createHash('sha256').update(v).digest('base64url'));
    assert.ok(v.length >= 43 && v.length <= 128, 'RFC 7636 verifier length');
    assert.notEqual(newCodeVerifier(), newCodeVerifier());
  });

  test('the consent URL carries everything PostHog requires and no secret', () => {
    const verifier = newCodeVerifier();
    const url = new URL(buildConsentUrl({ host: 'https://eu.posthog.com', clientId: clientIdFor(ORIGIN), redirectUri: redirectUriFor(ORIGIN), state: 'nonce123', codeVerifier: verifier }));
    assert.equal(url.origin + url.pathname, 'https://eu.posthog.com/oauth/authorize/');
    const q = url.searchParams;
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('client_id'), `${ORIGIN}/api/posthog/oauth-client`);
    assert.equal(q.get('redirect_uri'), `${ORIGIN}/api/posthog/callback`);
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('code_challenge'), codeChallengeFor(verifier));
    assert.equal(q.get('state'), 'nonce123');
    assert.deepEqual(q.get('scope').split(' ').sort(), ['email', 'openid', 'project:read', 'query:read']);
    assert.ok(!url.toString().includes(verifier), 'the verifier itself must never be in the URL');
  });
});

describe('exchanging the code', () => {
  const args = { code: 'abc', redirectUri: 'https://app.superrank.si/api/posthog/callback', clientId: `${ORIGIN}/api/posthog/oauth-client`, host: 'https://us.posthog.com', codeVerifier: 'verifier' };

  test('a real token response becomes tokens + the email, and the request is a public-client PKCE exchange', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url, init }); return url.endsWith('/oauth/token/') ? json(200, REAL_TOKEN_RESPONSE) : json(200, { email: 'maya@brightsmile.com', sub: 'x' }); };
    const out = await exchangeCode(args, { fetchImpl, now: 1_000_000 });
    assert.equal(out.accessToken, 'pha_access'); assert.equal(out.refreshToken, 'phr_refresh'); assert.equal(out.email, 'maya@brightsmile.com');
    assert.equal(out.expiresAt.getTime(), 1_000_000 + 3600 * 1000);
    assert.deepEqual(out.scopedTeams, ['1', '2']);
    const body = new URLSearchParams(seen[0].init.body);
    assert.equal(seen[0].url, 'https://us.posthog.com/oauth/token/');
    assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.get('code_verifier'), 'verifier'); assert.equal(body.get('client_id'), args.clientId);
    assert.ok(!body.has('client_secret'), 'a public client sends no secret');
    assert.equal(seen[1].init.headers.Authorization, 'Bearer pha_access');
  });

  test('a person who unticks a required scope on PostHog\'s screen is refused in words', async () => {
    const fetchImpl = async () => json(200, { ...REAL_TOKEN_RESPONSE, scope: 'openid email project:read' });
    await assert.rejects(() => exchangeCode(args, { fetchImpl }), (e) => e.code === 'missing_scopes');
  });

  test('no refresh token means the connection would die in an hour, so it is refused', async () => {
    const { refresh_token, ...noRefresh } = REAL_TOKEN_RESPONSE;
    await assert.rejects(() => exchangeCode(args, { fetchImpl: async () => json(200, noRefresh) }), (e) => e.code === 'no_refresh_token');
  });

  test('PostHog rejecting the code, and PostHog being unreachable, are different named failures', async () => {
    await assert.rejects(() => exchangeCode(args, { fetchImpl: async () => json(400, { error: 'invalid_grant', error_description: 'bad code' }) }), (e) => e.code === 'exchange_failed');
    await assert.rejects(() => exchangeCode(args, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), (e) => e.code === 'unreachable');
  });

  test('the email is display-only: a failing userinfo call does not fail the connection', async () => {
    const fetchImpl = async (url) => (url.endsWith('/oauth/token/') ? json(200, REAL_TOKEN_RESPONSE) : json(500, {}));
    assert.equal((await exchangeCode(args, { fetchImpl })).email, null);
  });
});

describe('refreshing', () => {
  const a = { host: 'https://us.posthog.com', refreshToken: 'phr_old', clientId: 'https://app.superrank.si/api/posthog/oauth-client' };

  test('a refresh returns the new access token and the ROTATED refresh token', async () => {
    const seen = [];
    const out = await refreshAccessToken(a, { fetchImpl: async (u, init) => { seen.push(new URLSearchParams(init.body)); return json(200, { access_token: 'pha_new', expires_in: 3600, refresh_token: 'phr_new', token_type: 'Bearer' }); }, now: 0 });
    assert.deepEqual([out.ok, out.accessToken, out.refreshToken], [true, 'pha_new', 'phr_new']);
    assert.equal(seen[0].get('grant_type'), 'refresh_token'); assert.equal(seen[0].get('refresh_token'), 'phr_old');
  });

  test('when PostHog does not rotate, the old refresh token is kept', async () => {
    const out = await refreshAccessToken(a, { fetchImpl: async () => json(200, { access_token: 'pha_new', expires_in: 3600 }) });
    assert.equal(out.refreshToken, 'phr_old');
  });

  test('a revoked grant is "unauthorized" (reconnect), an outage is not (retry tomorrow) — and neither throws', async () => {
    const revoked = await refreshAccessToken(a, { fetchImpl: async () => json(400, { error: 'invalid_grant' }) });
    assert.deepEqual([revoked.ok, revoked.reason], [false, 'unauthorized']);
    const down = await refreshAccessToken(a, { fetchImpl: async () => { throw new Error('ETIMEDOUT'); } });
    assert.deepEqual([down.ok, down.reason], [false, 'unreachable']);
    const broken = await refreshAccessToken(a, { fetchImpl: async () => json(503, {}) });
    assert.deepEqual([broken.ok, broken.reason], [false, 'failed']);
  });

  test('revoking is best effort: a failure returns false instead of throwing', async () => {
    assert.equal(await revokeToken({ host: a.host, token: 't', clientId: a.clientId }, { fetchImpl: async () => json(200, {}) }), true);
    assert.equal(await revokeToken({ host: a.host, token: 't', clientId: a.clientId }, { fetchImpl: async () => { throw new Error('down'); } }), false);
  });
});

describe('the project picker', () => {
  test('reads PostHog\'s own list (plain array or paged) and returns only id, name and url', async () => {
    const paged = { count: 2, results: [{ id: 4521, name: 'BrightSmile website', app_urls: ['https://brightsmile.com'], api_token: 'phc_secret', organization: 'o' }, { id: 4890, name: 'Booking app', app_urls: [] }] };
    const out = await listProjects({ host: 'https://us.posthog.com', accessToken: 'pha' }, { fetchImpl: async () => json(200, paged) });
    assert.deepEqual(out.projects, [{ id: '4521', name: 'BrightSmile website', url: 'https://brightsmile.com' }, { id: '4890', name: 'Booking app', url: null }]);
    assert.ok(!JSON.stringify(out).includes('phc_secret'), 'a project\'s own token must never be passed on');
    const arr = await listProjects({ host: 'https://us.posthog.com', accessToken: 'pha' }, { fetchImpl: async () => json(200, [{ id: 1, name: 'A' }]) });
    assert.equal(arr.projects.length, 1);
  });

  test('a grant limited to specific projects only offers those', async () => {
    const out = await listProjects({ host: 'https://us.posthog.com', accessToken: 'pha', scopedTeams: ['4890'] }, { fetchImpl: async () => json(200, { results: [{ id: 4521, name: 'A' }, { id: 4890, name: 'B' }] }) });
    assert.deepEqual(out.projects.map((p) => p.id), ['4890']);
  });

  test('failures are returned and named', async () => {
    assert.equal((await listProjects({ host: 'https://us.posthog.com', accessToken: 'x' }, { fetchImpl: async () => json(401, {}) })).reason, 'unauthorized');
    assert.equal((await listProjects({ host: 'https://us.posthog.com', accessToken: 'x' }, { fetchImpl: async () => { throw new Error('x'); } })).reason, 'unreachable');
  });
});

// ── hardening: where a credential may be sent, redirects, and what counts as "revoked" ─────────────────────

describe('validatePosthogHost / hostGuard', () => {
  const publicDns = async () => [{ address: '203.0.113.7', family: 4 }];

  test('PostHog\'s clouds pass without any lookup; anything else is checked', async () => {
    const noLookup = async () => { throw new Error('must not be called'); };
    assert.equal(await validatePosthogHost('https://us.posthog.com', { lookup: noLookup }), 'https://us.posthog.com');
    assert.equal(await validatePosthogHost('https://eu.posthog.com/', { lookup: noLookup }), 'https://eu.posthog.com');
    assert.equal(await validatePosthogHost('ph.example.com:8443', { lookup: publicDns }), 'https://ph.example.com:8443');
  });

  test('http, loopback, private, link-local, IPv6 internal, embedded credentials and unresolvable names are all refused', async () => {
    for (const host of ['http://ph.example.com', 'ftp://ph.example.com', 'https://localhost', 'https://app.localhost', 'https://0.0.0.0', 'https://127.0.0.1', 'https://10.0.0.1', 'https://172.16.5.5', 'https://192.168.1.1',
      'https://169.254.169.254', 'https://100.64.0.1', 'https://[::1]', 'https://[fd00::1]', 'https://[fe80::1]', 'https://[::ffff:10.0.0.1]', 'https://a:b@ph.example.com', '', '   ']) {
      await assert.rejects(() => validatePosthogHost(host, { lookup: publicDns }), (e) => e instanceof PosthogConnectError && e.code === 'bad_host', JSON.stringify(host));
    }
    await assert.rejects(() => validatePosthogHost('https://x.example.com', { lookup: async () => [{ address: '10.0.0.9' }] }), (e) => e.code === 'bad_host');
    await assert.rejects(() => validatePosthogHost('https://x.example.com', { lookup: async () => [{ address: '203.0.113.1' }, { address: '10.0.0.9' }] }), (e) => e.code === 'bad_host', 'ANY internal answer refuses');
    await assert.rejects(() => validatePosthogHost('https://x.example.com', { lookup: async () => { throw new Error('ENOTFOUND'); } }), (e) => e.code === 'bad_host');
  });

  test('hostGuard returns a failure instead of throwing, caches only successes, and re-checks once the entry lapses', async () => {
    forgetHostChecks();
    let calls = 0; let address = '203.0.113.7';
    const lookup = async () => { calls++; return [{ address }]; };
    assert.equal(await hostGuard('https://ph.example.com', { lookup, now: 0 }), null);
    assert.equal(await hostGuard('https://ph.example.com', { lookup, now: 1000 }), null);
    assert.equal(calls, 1, 'a fresh success is cached');
    address = '10.0.0.9'; // the name now points inward
    assert.equal(await hostGuard('https://ph.example.com', { lookup, now: 1000 }), null, 'still inside the cache window');
    const later = await hostGuard('https://ph.example.com', { lookup, now: 6 * 60 * 1000 });
    assert.deepEqual([later.ok, later.reason], [false, 'bad_host']);
    assert.equal(calls, 2);
    assert.equal((await hostGuard('https://ph.example.com', { lookup, now: 6 * 60 * 1000 + 1 })).reason, 'bad_host', 'a failure is not cached as good');
  });

  test('an address refused by the guard gets NO request, from any of the OAuth calls', async () => {
    forgetHostChecks();
    const seen = [];
    const fetchImpl = async (u) => { seen.push(u); return json(200, {}); };
    const bad = 'https://10.0.0.5';
    const a = await refreshAccessToken({ host: bad, refreshToken: 'r', clientId: 'c' }, { fetchImpl });
    const l = await listProjects({ host: bad, accessToken: 't' }, { fetchImpl });
    const r = await revokeToken({ host: bad, token: 't', clientId: 'c' }, { fetchImpl });
    assert.deepEqual([a.reason, l.reason, r], ['bad_host', 'bad_host', false]);
    await assert.rejects(() => exchangeCode({ code: 'c', redirectUri: 'x', clientId: 'c', host: bad, codeVerifier: 'v' }, { fetchImpl }), (e) => e.code === 'exchange_failed');
    assert.deepEqual(seen, []);
  });
});

describe('redirects are never followed', () => {
  test('every call to PostHog says redirect: manual', async () => {
    forgetHostChecks();
    const inits = [];
    const fetchImpl = async (u, init) => { inits.push([u.split('?')[0].replace('https://us.posthog.com', ''), init.redirect]); return u.includes('/oauth/token/') ? json(200, REAL_TOKEN_RESPONSE) : json(200, { email: 'a@b.co', results: [] }); };
    const host = 'https://us.posthog.com';
    await exchangeCode({ code: 'c', redirectUri: 'x', clientId: 'cid', host, codeVerifier: 'v' }, { fetchImpl });
    await refreshAccessToken({ host, refreshToken: 'r', clientId: 'cid' }, { fetchImpl });
    await listProjects({ host, accessToken: 't' }, { fetchImpl });
    await revokeToken({ host, token: 't', clientId: 'cid' }, { fetchImpl });
    assert.deepEqual(inits.map((i) => i[0]).sort(), ['/api/projects/', '/oauth/revoke/', '/oauth/token/', '/oauth/token/', '/oauth/userinfo/']);
    for (const [path, redirect] of inits) assert.equal(redirect, 'manual', path);
  });

  test('a 3xx from the token endpoint is a transient failure, not a revoked grant', async () => {
    forgetHostChecks();
    const out = await refreshAccessToken({ host: 'https://us.posthog.com', refreshToken: 'r', clientId: 'c' }, { fetchImpl: async () => ({ ok: false, status: 302, json: async () => { throw new Error('no body'); } }) });
    assert.deepEqual([out.ok, out.reason], [false, 'failed']);
  });
});

describe('only a dead grant means "reconnect"', () => {
  const a = { host: 'https://us.posthog.com', refreshToken: 'phr', clientId: 'c' };
  const refreshWith = (status, body) => refreshAccessToken(a, { fetchImpl: async () => ({ ok: false, status, json: async () => body }) });

  test('invalid_grant, invalid_client, unauthorized_client (RFC 6749 section 5.2) and a bare 401 are unauthorized', async () => {
    for (const [st, body] of [[400, { error: 'invalid_grant' }], [400, { error: 'invalid_client' }], [401, { error: 'invalid_client' }], [400, { error: 'unauthorized_client' }], [401, null]]) {
      const out = await refreshWith(st, body);
      assert.equal(out.reason, 'unauthorized', `${st} ${JSON.stringify(body)}`);
    }
  });

  test('a malformed request, a rate limit, an outage and a gateway page are NOT: they say nothing about the grant', async () => {
    for (const [st, body] of [[400, { error: 'invalid_request' }], [400, { error: 'unsupported_grant_type' }], [400, null], [400, {}], [429, { error: 'rate_limited' }], [500, null], [502, null], [503, { error: 'temporarily_unavailable' }]]) {
      const out = await refreshWith(st, body);
      assert.equal(out.reason, 'failed', `${st} ${JSON.stringify(body)}`);
    }
  });
});
