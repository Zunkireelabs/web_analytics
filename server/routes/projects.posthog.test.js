import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Route-level coverage for project-level access: what a person with access to ONE
// project can and cannot do, and that nothing leaks across projects or to the
// workspace that holds them. requireAuth (layer 0) is covered in
// workspaces-isolation.test.js; here the remaining layers run in order.

process.env.COMPANY_SITE_ID = '1';

const real = await import(resolve('../store/workspaces.js') + '?real');

const PLATFORM = 1; const OWNER = 12; const WSADMIN = 11; const PADMIN = 20; const PREAD = 21; const STRANGER = 22; const EXISTING = 23;
const ADMIZZ = 40; const CHAYCE = 41;
let users;
let access; // `${userId}:${siteId}` -> { membershipRole, projectRole }
let calls;
let wsRoles; // `${userId}:${workspaceId}` -> membership role (target workspaces)
const resetCalls = () => { calls = { softDeleted: [], transfers: [], goals: [], tokens: [], revoked: [], invitations: [], emails: [], projectMembers: [], roleUpdates: [], removals: [], audit: [] }; };
const SITES = { 1: { id: 1, name: 'Zunkiree Labs', website_domain: 'zunkiree.com', workspace_id: 8 }, [ADMIZZ]: { id: ADMIZZ, name: 'Admizz Education', website_domain: 'admizz.com', workspace_id: 8, gsc_property: 'sc-domain:admizz.com', ga4_property_id: '1' }, [CHAYCE]: { id: CHAYCE, name: 'Chayceproperties', website_domain: 'chayce.com', workspace_id: 8, gsc_property: null, ga4_property_id: null } };

const realUsers = await import(resolve('../store/users.js') + '?real');
mock.module(resolve('../store/users.js'), {
  namedExports: {
    ...realUsers,
    getUserById: async (id) => users[id] || null,
    getUserByEmail: async (email) => Object.values(users).find((u) => u.email === email) || null,
    updateUserPassword: async () => { throw new Error('not exercised'); },
    createUser: async () => { throw new Error('not exercised'); },
    getUserStatus: async () => 'active',
  },
});
const realRead = await import(resolve('../store/read.js') + '?real');
mock.module(resolve('../store/read.js'), { namedExports: { ...realRead, getSiteById: async () => null, getSiteStatus: async () => 'active' } });
mock.module(resolve('../store/user-invitations.js'), {
  namedExports: {
    createInvitation: async (o) => { calls.invitations.push(o); return { id: 99, token: 't0ken', expires_at: 'soon' }; },
    acceptInvitation: async () => null,
  },
});
const realEmail = await import(resolve('../report/email.js') + '?real');
mock.module(resolve('../report/email.js'), {
  namedExports: { ...realEmail, sendInvitationEmail: async (o) => { calls.emails.push(o); return true; } },
});
mock.module(resolve('../store/admin/audit-log.js'), { namedExports: { recordAuditEvent: async (req, e) => { calls.audit.push(e.action); } } });
mock.module(resolve('../store/workspaces.js'), {
  namedExports: {
    ...real,
    getAccessContext: async (userId, siteId) => {
      const u = users[userId]; if (!u) return null;
      const a = access[`${userId}:${siteId}`] || {};
      return {
        user: { id: u.id, role: u.role, site_id: u.site_id }, site: { id: siteId, workspace_id: SITES[siteId]?.workspace_id ?? null },
        membership: a.membershipRole ? { role: a.membershipRole } : null, projectMembership: a.projectRole ? { role: a.projectRole } : null,
      };
    },
    listWorkspacesForUser: async () => [], listSharedProjectsForUser: async () => [], pickLoginSite: async () => null,
    getProject: async (id) => SITES[id] || null,
    getWorkspaceById: async (id) => ({ id, name: 'Zunkiree Labs' }), // the host workspace: must never reach a project-only person
    getMembershipRole: async (userId, workspaceId) => wsRoles[`${userId}:${workspaceId}`] ?? ((workspaceId === 8 && users[userId]?.wsMember) || null),
    softDeleteProject: async (id) => { calls.softDeleted.push(id); return true; },
    transferProject: async (o) => { calls.transfers.push(o); return { ok: true, grants: [{ email: 'admizz@client.test' }] }; },
    validateGoal: real.validateGoal,
    setProjectGoal: async (o) => { calls.goals.push(o); return { site_id: o.siteId, goal: o.goal, growth: o.growth, months: o.months }; },
    listGoalsForSites: async () => ({ [ADMIZZ]: { goal: 'enquiries', growth: 'steady', months: 12 } }),
    listProjectActivity: async () => [{ id: 1, action: 'project.goal_set', actor_email: 'a@x.test', tenant_name: 'Admizz Education', metadata: {}, created_at: 'now' }],
    listProjectMembers: async (siteId) => [{ id: PADMIN, email: 'admizz@client.test', status: 'active', role: 'admin' }, { id: PREAD, email: 'viewer@client.test', status: 'active', role: 'member' }],
    listPendingInvitationsForProject: async () => [],
    getProjectMembershipRole: async (userId, siteId) => access[`${userId}:${siteId}`]?.projectRole ?? null,
    addProjectMember: async (siteId, userId, role, by) => { calls.projectMembers.push([siteId, userId, role, by]); return true; },
    updateProjectMemberRole: async (siteId, userId, role) => { calls.roleUpdates.push([siteId, userId, role]); return { role }; },
    removeProjectMember: async (siteId, userId) => { calls.removals.push([siteId, userId]); return true; },
  },
});
mock.module(resolve('../store/api-tokens.js'), {
  namedExports: {
    createApiToken: async (siteId, o) => { calls.tokens.push({ siteId, ...o }); return { id: 31, site_id: siteId, label: o.label, permission_level: o.permissionLevel, token: 'raw-secret' }; },
    listApiTokensForSite: async () => [{ id: 31, token_prefix: 'sr_ab', label: 'Claude', permission_level: 'read_only' }],
    revokeApiToken: async (siteId, id) => { calls.revoked.push([siteId, id]); return id === 31; },
    listApiTokensForWorkspace: async () => [], revokeApiTokenInWorkspace: async () => null,
  },
});
mock.module(resolve('../store/data-freshness.js'), { namedExports: { gscDailyDataAsOf: async () => ({ as_of: new Date().toISOString().slice(0, 10) }) } });
mock.module(resolve('../store/admin/system-health.js'), { namedExports: { getRecentAgentRunFailureCounts: async () => [] } });

const realConnect = await import(resolve('./lib/project-connect.js') + '?real');
mock.module(resolve('./lib/project-connect.js'), {
  namedExports: {
    ...realConnect,
    listGoogleProperties: async ({ auth } = {}) => (auth === OWN_AUTH ? OWN_LISTS : SHARED_LISTS),
    listGithubRepos: async () => ({
      repos: [{ owner: 'Zunkireelabs', name: 'admizz-web-dev', fullName: 'Zunkireelabs/admizz-web-dev', defaultBranch: 'main', private: true, installationId: '153416356', account: 'Zunkireelabs' }],
      installations: [{ id: 153416356, account: 'Zunkireelabs', repositorySelection: 'selected' }], installUrl: 'https://github.com/apps/superrank/installations/new',
    }),
  },
});

// The project's own Google connection: who connected (store), and the client built from its
// token (auth). Tests set `ownGoogle` per case; the lists the fake client "sees" are OWN_LISTS,
// while the shared SuperRank account sees SHARED_LISTS — every client's properties.
let ownGoogle = null;
let savedConnections = [];
const OWN_LISTS = {
  searchConsole: [{ property: 'sc-domain:admizz.com', domain: 'admizz.com', permission: 'siteOwner' }],
  analytics: [{ propertyId: '111', name: 'admizz.com' }],
};
const SHARED_LISTS = {
  searchConsole: [...OWN_LISTS.searchConsole, { property: 'sc-domain:other-client.com', domain: 'other-client.com', permission: 'siteOwner' }],
  analytics: [...OWN_LISTS.analytics, { propertyId: '999', name: 'other-client.com' }],
};
mock.module(resolve('../store/project-google.js'), {
  namedExports: {
    getGoogleConnection: async () => ownGoogle,
    saveGoogleConnection: async (o) => { savedConnections.push(o); },
    deleteGoogleConnection: async () => true,
    clearSiteGoogleProperties: async (id) => { clearedProperties.push(id); },
  },
});
const clearedProperties = [];
let baselineLock = null;
mock.module(resolve('../lib/job-lock.js'), {
  namedExports: { jobLockInfo: async () => baselineLock, jobKeyFor: (a, b) => `${a}:${b}`, withJobLock: async (_k, fn) => ({ ran: true, result: await fn() }) },
});
const OWN_AUTH = { __own: true };
mock.module(resolve('../auth/project-google.js'), {
  namedExports: { getProjectGoogleAuth: async () => OWN_AUTH, forgetProjectGoogleAuth: () => {}, oauthClientFor: () => OWN_AUTH },
});


// ───────── PostHog "Connect with PostHog" routes ─────────
// The routes own the parts that must not be wrong: who may start it, that the one-time state and PKCE verifier are bound to
// THIS session/user/project, that nothing is stored on a bad callback, and that no token ever leaves in a response.

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
delete process.env.POSTHOG_OAUTH_CLIENT_ID; delete process.env.POSTHOG_OAUTH_REDIRECT_URI;

let ph;           // the in-memory connection row
let phCalls;
let phListed;     // what PostHog "returns" as the person's projects
let phVerify;
let phExchange;
const resetPh = () => {
  ph = null; phCalls = { revoked: [], saved: [], selected: [], backfills: 0, status: [], keySaved: [] };
  phListed = { ok: true, projects: [{ id: '4521', name: 'BrightSmile website', url: 'https://brightsmile.com' }, { id: '4890', name: 'Booking app', url: null }] };
  phVerify = { ok: true };
  phExchange = async () => ({ accessToken: 'pha_secret_access', refreshToken: 'phr_secret_refresh', expiresAt: new Date(Date.now() + 3600_000), scopes: ['query:read', 'project:read'], scopedTeams: null, email: 'maya@brightsmile.com' });
};
resetPh();

mock.module(resolve('../store/project-posthog.js'), {
  namedExports: {
    getPosthogConnection: async () => (ph ? { project_id: ph.project_id, project_name: ph.project_name, host: ph.host, connected_email: ph.email, method: ph.method, status: ph.status, status_error: null, status_at: null, pending: ph.project_id == null, connected_by: 5, auth_method: ph.method } : null),
    savePosthogConnection: async (siteId, o) => { phCalls.keySaved.push({ siteId, ...o }); ph = { project_id: String(o.projectId), project_name: null, host: o.host || 'https://us.posthog.com', email: null, method: 'key', status: 'pending' }; return {}; },
    recordPosthogFailure: async (siteId, reason) => { const permanent = ['unauthorized', 'project_not_found', 'bad_host'].includes(reason); if (permanent) { phCalls.status.push(false); if (ph) ph.status = 'error'; } return permanent; },
    recordPosthogStatus: async (s, ok) => { phCalls.status.push(ok); if (ph) ph.status = ok ? 'ok' : 'error'; },
    getPosthogCredentials: async () => ({ projectId: ph?.project_id, host: ph?.host, apiKey: 'tok' }),
    deletePosthogConnection: async () => { const had = !!ph; ph = null; return had; },
    saveOauthSignIn: async (siteId, o) => { phCalls.saved.push({ siteId, ...o }); ph = { project_id: null, project_name: null, host: o.host, email: o.email, method: 'oauth', status: 'pending' }; return {}; },
    selectOauthProject: async (siteId, o) => { if (!ph || ph.method !== 'oauth') return null; phCalls.selected.push({ siteId, ...o }); ph.project_id = o.projectId; ph.project_name = o.projectName; ph.status = 'pending'; return { project_id: o.projectId }; },
    getFreshPosthogAccess: async () => (ph && ph.method === 'oauth' ? { ok: true, host: ph.host, projectId: ph.project_id, accessToken: 'pha_secret_access' } : { ok: false, reason: 'not_connected' }),
    getPosthogRevokeInfo: async () => (ph?.method === 'oauth' ? { host: ph.host, token: 'phr_secret_refresh', clientId: 'cid' } : null),
  },
});
const realPh = await import(resolve('../integrations/posthog-connect.js') + '?real');
mock.module(resolve('../integrations/posthog-connect.js'), {
  namedExports: {
    ...realPh,
    resolveHost: async ({ region, host }) => (region === 'self' ? (String(host).startsWith('https://') ? String(host).replace(/\/+$/, '') : (() => { throw new realPh.PosthogConnectError('bad_host', realPh.POSTHOG_ERRORS.bad_host); })()) : realPh.REGIONS[region || 'us']),
    validatePosthogHost: (host) => realPh.validatePosthogHost(host, { lookup: async () => [{ address: '203.0.113.7', family: 4 }] }), // no real DNS in tests
    exchangeCode: async (a) => phExchange(a),
    listProjects: async () => phListed,
    revokeToken: async (a) => { phCalls.revoked.push(a); return true; },
  },
});
mock.module(resolve('../ingest/posthog.js'), { namedExports: { verifyConnection: async () => phVerify } });
mock.module(resolve('../lib/posthog-backfill.js'), { namedExports: { backfillPosthog: async () => { phCalls.backfills += 1; return { ok: true, imported: 3 }; } } });

const router = (await import('./projects.js')).default;

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {}, redirected: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.redirect = (u) => { res.redirected = u; return res; };
  return res;
}
async function call(method, path, { userId, params = {}, body = {}, query = {}, host = 'app.superrank.si', protocol = 'https', session = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  const req = { userId, siteId: ADMIZZ, params, body, query, session, protocol, get: () => host };
  const res = mockRes();
  // The first layer of a gated route is requireAuth (covered in workspaces-isolation.test.js); a public route has just its handler.
  const stack = layer.route.stack.length > 1 ? layer.route.stack.slice(1) : layer.route.stack;
  for (const l of stack) {
    let proceeded = false;
    await l.handle(req, res, (err) => { if (err) throw err; proceeded = true; });
    if (!proceeded) break;
  }
  return Object.assign(res, { req });
}
const P = (siteId, extra = {}) => ({ siteId: String(siteId), ...extra });

beforeEach(() => {
  resetCalls(); resetPh();
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  users = {
    [PADMIN]: { id: PADMIN, email: 'admizz@client.test', role: 'tenant_admin', site_id: ADMIZZ },
    [PREAD]: { id: PREAD, email: 'viewer@client.test', role: 'tenant_member', site_id: ADMIZZ },
    [STRANGER]: { id: STRANGER, email: 'nobody@else.test', role: 'tenant_admin', site_id: 9 },
  };
  access = { [`${PADMIN}:${ADMIZZ}`]: { projectRole: 'admin' }, [`${PREAD}:${ADMIZZ}`]: { projectRole: 'member' } };
  wsRoles = {};
});

// The history import is deliberately not awaited by the route (the person is watching a button), so let it land.
const settle = () => new Promise((r) => setTimeout(r, 40));

const noSecrets = (value) => {
  const s = JSON.stringify(value);
  for (const secret of ['pha_secret_access', 'phr_secret_refresh', 'code_verifier']) assert.ok(!s.includes(secret), `${secret} must never leave in a response`);
};

describe('the client document PostHog fetches', () => {
  test('is public (no auth layer), cached for a few minutes, and describes this client', async () => {
    const layer = router.stack.find((l) => l.route?.path === '/posthog/oauth-client' && l.route.methods.get);
    assert.equal(layer.route.stack.length, 1, 'PostHog fetches it with no session, so nothing may gate it');
    const res = await call('get', '/posthog/oauth-client');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Cache-Control'], /public, max-age=\d+/);
    assert.equal(res.body.client_id, 'https://app.superrank.si/api/posthog/oauth-client');
    assert.deepEqual(res.body.redirect_uris, ['https://app.superrank.si/api/posthog/callback']);
  });
});

describe('GET connect/posthog (the connection screen)', () => {
  test('not connected: says so, and says whether this server can start the sign-in', async () => {
    const res = await call('get', '/projects/:siteId/connect/posthog', { userId: PADMIN, params: P(ADMIZZ) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.body.connected, res.body.pending, res.body.connection, res.body.canConnect], [false, false, null, true]);
    assert.ok(res.body.guide);
    assert.equal((await call('get', '/projects/:siteId/connect/posthog', { userId: PADMIN, params: P(ADMIZZ), host: 'localhost:5174', protocol: 'http' })).body.canConnect, false);
    delete process.env.SECRETS_ENCRYPTION_KEY;
    assert.equal((await call('get', '/projects/:siteId/connect/posthog', { userId: PADMIN, params: P(ADMIZZ) })).body.canConnect, false);
  });

  test('signed in but no project chosen is `pending`, not connected; chosen is connected; the shape is exactly the contract and has no secret', async () => {
    ph = { project_id: null, project_name: null, host: 'https://us.posthog.com', email: 'maya@brightsmile.com', method: 'oauth', status: 'pending' };
    let res = await call('get', '/projects/:siteId/connect/posthog', { userId: PADMIN, params: P(ADMIZZ) });
    assert.deepEqual([res.body.connected, res.body.pending], [false, true]);
    ph.project_id = '4521'; ph.project_name = 'BrightSmile website'; ph.status = 'ok';
    res = await call('get', '/projects/:siteId/connect/posthog', { userId: PADMIN, params: P(ADMIZZ) });
    assert.deepEqual([res.body.connected, res.body.pending], [true, false]);
    assert.deepEqual(Object.keys(res.body.connection).sort(), ['connected_as', 'host', 'method', 'project_id', 'project_name', 'status', 'status_at', 'status_error']);
    assert.equal(res.body.connection.connected_as, 'maya@brightsmile.com'); assert.equal(res.body.connection.method, 'oauth');
    noSecrets(res.body);
  });

  test('only a project admin (a stranger gets 404)', async () => {
    assert.equal((await call('get', '/projects/:siteId/connect/posthog', { userId: PREAD, params: P(ADMIZZ) })).statusCode, 403);
    assert.equal((await call('get', '/projects/:siteId/connect/posthog', { userId: STRANGER, params: P(ADMIZZ) })).statusCode, 404);
  });
});

describe('start', () => {
  const start = (over = {}) => call('get', '/projects/:siteId/connect/posthog/start', { userId: PADMIN, params: P(ADMIZZ), ...over });

  test('hands back PostHog\'s address with PKCE, and keeps the verifier ONLY in this session', async () => {
    const session = {};
    const res = await start({ session, query: { region: 'eu' } });
    assert.equal(res.statusCode, 200);
    const url = new URL(res.body.url);
    assert.equal(url.origin + url.pathname, 'https://eu.posthog.com/oauth/authorize/');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.superrank.si/api/posthog/callback');
    const s = session.posthogConnect;
    assert.deepEqual([s.siteId, s.userId, s.host], [ADMIZZ, PADMIN, 'https://eu.posthog.com']);
    assert.equal(url.searchParams.get('state'), s.nonce);
    assert.equal(url.searchParams.get('code_challenge'), realPh.codeChallengeFor(s.codeVerifier));
    assert.ok(!res.body.url.includes(s.codeVerifier));
  });

  test('says so plainly when the server cannot do it: localhost, no storage key, or a bad self-hosted address', async () => {
    assert.equal((await start({ host: 'localhost:5174', protocol: 'http' })).body.code, 'NOT_CONFIGURED');
    delete process.env.SECRETS_ENCRYPTION_KEY;
    assert.equal((await start()).body.code, 'NO_ENCRYPTION_KEY');
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    const bad = await start({ query: { region: 'self', host: 'http://10.0.0.1' } });
    assert.deepEqual([bad.statusCode, bad.body.code], [400, 'BAD_HOST']);
    assert.equal((await start({ query: { region: 'self', host: 'https://ph.example.com/' } })).statusCode, 200);
  });

  test('only a project admin can start it', async () => {
    assert.equal((await start({ userId: PREAD })).statusCode, 403);
    assert.equal((await start({ userId: STRANGER })).statusCode, 404);
  });
});

describe('callback', () => {
  const pendingFor = (over = {}) => ({ nonce: 'abc', siteId: ADMIZZ, userId: PADMIN, redirectUri: 'https://app.superrank.si/api/posthog/callback', clientId: 'cid', host: 'https://us.posthog.com', codeVerifier: 'v', at: Date.now(), ...over });
  const back = (res) => new URL(res.redirected, 'https://app.superrank.si');
  const cb = (query, session) => call('get', '/posthog/callback', { query, session });

  test('a good sign-in with several projects is stored (encrypted by the store) and sends the person to the picker', async () => {
    const session = { userId: PADMIN, posthogConnect: pendingFor() };
    const res = await cb({ code: 'c', state: 'abc' }, session);
    const u = back(res);
    assert.equal(u.pathname, '/workspace');
    assert.deepEqual([u.searchParams.get('finish'), u.searchParams.get('posthog')], [String(ADMIZZ), 'connected']);
    assert.equal(phCalls.saved.length, 1); assert.equal(phCalls.saved[0].siteId, ADMIZZ); assert.equal(phCalls.saved[0].email, 'maya@brightsmile.com');
    assert.equal(phCalls.selected.length, 0, 'two projects: the person chooses');
    assert.equal(session.posthogConnect, undefined, 'single use');
    assert.deepEqual(calls.audit, ['project.posthog_connected']);
  });

  test('a sign-in that can only see ONE project connects it straight away, verifies it and imports history', async () => {
    phListed = { ok: true, projects: [{ id: '4521', name: 'BrightSmile website', url: null }] };
    const res = await cb({ code: 'c', state: 'abc' }, { userId: PADMIN, posthogConnect: pendingFor() });
    assert.equal(back(res).searchParams.get('posthog'), 'saved');
    assert.deepEqual([phCalls.selected[0].projectId, phCalls.selected[0].projectName], ['4521', 'BrightSmile website']);
    await settle();
    assert.equal(ph.status, 'ok'); assert.equal(phCalls.backfills, 1);
  });

  test('wrong state, no pending sign-in, someone else\'s session, a stale link, or a read-only member: nothing is stored', async () => {
    const cases = [
      [{ code: 'c', state: 'WRONG' }, { userId: PADMIN, posthogConnect: pendingFor() }, 'expired'],
      [{ code: 'c', state: 'abc' }, { userId: PADMIN }, 'expired'],
      [{ code: 'c', state: 'abc' }, { userId: STRANGER, posthogConnect: pendingFor() }, 'expired'],
      [{ code: 'c', state: 'abc' }, { userId: PADMIN, posthogConnect: pendingFor({ at: Date.now() - 11 * 60 * 1000 }) }, 'expired'],
      [{ code: 'c', state: 'abc' }, { userId: PREAD, posthogConnect: pendingFor({ userId: PREAD }) }, 'denied'],
    ];
    for (const [query, session, code] of cases) {
      const res = await cb(query, session);
      assert.equal(back(res).searchParams.get('pherror'), code);
    }
    assert.equal(phCalls.saved.length, 0); assert.equal(ph, null);
  });

  test('cancelling on PostHog\'s screen stores nothing and says so', async () => {
    const res = await cb({ error: 'access_denied', state: 'abc' }, { userId: PADMIN, posthogConnect: pendingFor() });
    assert.equal(back(res).searchParams.get('pherror'), 'cancelled');
    assert.equal(phCalls.saved.length, 0);
  });

  test('a not-signed-in browser is sent home, and PostHog refusing the code is a named failure with nothing stored', async () => {
    assert.equal((await cb({ code: 'c', state: 'abc' }, {})).redirected, '/');
    phExchange = async () => { throw new realPh.PosthogConnectError('missing_scopes', 'x'); };
    const res = await cb({ code: 'c', state: 'abc' }, { userId: PADMIN, posthogConnect: pendingFor() });
    assert.equal(back(res).searchParams.get('pherror'), 'missing_scopes');
    phExchange = async () => { throw new Error('boom'); };
    assert.equal(back(await cb({ code: 'c', state: 'abc' }, { userId: PADMIN, posthogConnect: pendingFor() })).searchParams.get('pherror'), 'exchange_failed');
    assert.equal(phCalls.saved.length, 0);
  });
});

describe('the project picker', () => {
  const signedIn = () => { ph = { project_id: null, project_name: null, host: 'https://us.posthog.com', email: 'maya@brightsmile.com', method: 'oauth', status: 'pending' }; };

  test('lists the projects this sign-in can read, and nothing secret', async () => {
    signedIn();
    const res = await call('get', '/projects/:siteId/connect/posthog/projects', { userId: PADMIN, params: P(ADMIZZ) });
    assert.deepEqual(res.body.projects.map((p) => [p.id, p.name]), [['4521', 'BrightSmile website'], ['4890', 'Booking app']]);
    noSecrets(res.body);
  });

  test('asks the person to sign in first when they have not, and reports PostHog being down as such', async () => {
    const res = await call('get', '/projects/:siteId/connect/posthog/projects', { userId: PADMIN, params: P(ADMIZZ) });
    assert.deepEqual([res.statusCode, res.body.code], [409, 'NOT_SIGNED_IN']);
    signedIn(); phListed = { ok: false, reason: 'unreachable', detail: 'ETIMEDOUT' };
    assert.equal((await call('get', '/projects/:siteId/connect/posthog/projects', { userId: PADMIN, params: P(ADMIZZ) })).statusCode, 502);
  });

  test('choosing one verifies it, connects it, and imports history; the response has no secret', async () => {
    signedIn();
    const res = await call('post', '/projects/:siteId/connect/posthog/select', { userId: PADMIN, params: P(ADMIZZ), body: { projectId: '4890' } });
    assert.deepEqual([res.statusCode, res.body.connected, res.body.verified, res.body.backfilling], [200, true, true, true]);
    assert.equal(res.body.connection.project_name, 'Booking app');
    await settle();
    assert.equal(phCalls.backfills, 1); assert.equal(ph.status, 'ok');
    noSecrets(res.body);
  });

  test('a project id the browser made up (not in PostHog\'s own list) is refused', async () => {
    signedIn();
    const res = await call('post', '/projects/:siteId/connect/posthog/select', { userId: PADMIN, params: P(ADMIZZ), body: { projectId: '99999' } });
    assert.equal(res.statusCode, 400);
    assert.equal(phCalls.selected.length, 0);
    assert.equal((await call('post', '/projects/:siteId/connect/posthog/select', { userId: PADMIN, params: P(ADMIZZ), body: {} })).statusCode, 400);
  });

  test('a project that PostHog will not let us read is reported on the screen, not left looking connected', async () => {
    signedIn(); phVerify = { ok: false, reason: 'project_not_found', detail: 'PostHog has no project 4521.' };
    const res = await call('post', '/projects/:siteId/connect/posthog/select', { userId: PADMIN, params: P(ADMIZZ), body: { projectId: '4521' } });
    assert.deepEqual([res.statusCode, res.body.verified, res.body.error], [400, false, 'PostHog has no project 4521.']);
    await settle();
    assert.equal(ph.status, 'error'); assert.equal(phCalls.backfills, 0);
  });

  test('only a project admin', async () => {
    signedIn();
    for (const [m, path] of [['get', '/projects/:siteId/connect/posthog/projects'], ['post', '/projects/:siteId/connect/posthog/select']]) {
      assert.equal((await call(m, path, { userId: PREAD, params: P(ADMIZZ), body: { projectId: '4521' } })).statusCode, 403, path);
      assert.equal((await call(m, path, { userId: STRANGER, params: P(ADMIZZ), body: { projectId: '4521' } })).statusCode, 404, path);
    }
    assert.equal(phCalls.selected.length, 0);
  });
});

describe('disconnecting', () => {
  test('removes the connection AND tells PostHog to forget the grant, and audits it', async () => {
    ph = { project_id: '4521', project_name: 'P', host: 'https://us.posthog.com', email: 'm@x.com', method: 'oauth', status: 'ok' };
    const res = await call('delete', '/projects/:siteId/connect/posthog', { userId: PADMIN, params: P(ADMIZZ) });
    assert.deepEqual(res.body, { removed: true });
    assert.deepEqual(phCalls.revoked, [{ host: 'https://us.posthog.com', token: 'phr_secret_refresh', clientId: 'cid' }]);
    assert.deepEqual(calls.audit, ['project.posthog_disconnected']);
    assert.equal(ph, null);
  });

  test('a pasted key has nothing to revoke, and disconnecting nothing is harmless', async () => {
    ph = { project_id: '9', host: 'https://us.posthog.com', method: 'key', status: 'ok' };
    assert.deepEqual((await call('delete', '/projects/:siteId/connect/posthog', { userId: PADMIN, params: P(ADMIZZ) })).body, { removed: true });
    assert.equal(phCalls.revoked.length, 0);
    assert.deepEqual((await call('delete', '/projects/:siteId/connect/posthog', { userId: PADMIN, params: P(ADMIZZ) })).body, { removed: false });
  });

  test('only a project admin', async () => {
    assert.equal((await call('delete', '/projects/:siteId/connect/posthog', { userId: PREAD, params: P(ADMIZZ) })).statusCode, 403);
  });
});

describe('pasting a key (the other way to connect)', () => {
  const paste = (body, userId = PADMIN) => call('post', '/projects/:siteId/connect/posthog', { userId, params: P(ADMIZZ), body: { projectId: '4521', apiKey: 'phx_secret_key', ...body } });

  test('the address that will receive the key gets the same checks as a sign-in\'s: http, loopback, private and link-local are refused, nothing is stored or sent', async () => {
    for (const host of ['http://ph.example.com', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.5', 'https://192.168.1.10', 'https://169.254.169.254', 'https://[::1]', 'https://u:p@ph.example.com', 'ftp://ph.example.com']) {
      const res = await paste({ host });
      assert.deepEqual([res.statusCode, res.body.code], [400, 'BAD_HOST'], host);
    }
    assert.equal(phCalls.keySaved.length, 0, 'a refused address must not even be stored');
    noSecrets(phCalls); // and the key is not echoed anywhere
  });

  test('a good self-hosted address is stored in its normalised form; blank means the US cloud', async () => {
    assert.equal((await paste({ host: 'ph.client.io/' })).statusCode, 200);
    assert.equal(phCalls.keySaved[0].host, 'https://ph.client.io');
    await paste({ host: '' });
    assert.equal(phCalls.keySaved[1].host, null);
    await settle();
  });

  test('a momentary PostHog outage is reported to the person but NOT recorded, so it cannot switch the nightly job off', async () => {
    phVerify = { ok: false, reason: 'unreachable', detail: 'ETIMEDOUT' };
    const res = await paste({ host: 'ph.client.io' });
    assert.deepEqual([res.statusCode, res.body.verified, res.body.error], [400, false, 'ETIMEDOUT']);
    assert.deepEqual(phCalls.status, []);
    assert.equal(ph.status, 'pending', 'still pending: tomorrow\'s run will try it');
    await settle(); assert.equal(phCalls.backfills, 0);
  });

  test('a refused key IS recorded (that is about the connection), and the person is told', async () => {
    phVerify = { ok: false, reason: 'unauthorized', detail: 'PostHog rejected the API key (HTTP 401).' };
    const res = await paste({ host: '' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(phCalls.status, [false]);
    assert.equal(ph.status, 'error');
  });

  test('a picked project hit by an outage is reported but not recorded either', async () => {
    ph = { project_id: null, project_name: null, host: 'https://us.posthog.com', email: 'm@x.com', method: 'oauth', status: 'pending' };
    phVerify = { ok: false, reason: 'failed', detail: 'HTTP 503' };
    const res = await call('post', '/projects/:siteId/connect/posthog/select', { userId: PADMIN, params: P(ADMIZZ), body: { projectId: '4521' } });
    assert.deepEqual([res.statusCode, res.body.verified], [400, false]);
    assert.deepEqual(phCalls.status, []);
    assert.equal(ph.status, 'pending');
  });

  test('only a project admin can paste a key', async () => {
    assert.equal((await paste({}, PREAD)).statusCode, 403);
    assert.equal((await paste({}, STRANGER)).statusCode, 404);
  });
});
