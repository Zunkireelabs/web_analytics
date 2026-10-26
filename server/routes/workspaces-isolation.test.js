import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const resolve = (p) => new URL(p, import.meta.url).href;

// Route-level isolation for the workspace layer: requireAuth must refuse a
// session whose active project the user has no membership in, and the switch
// endpoint must not let a user move into someone else's workspace.

process.env.COMPANY_SITE_ID = '1';

// The real decision function, loaded under a different URL so the mock below
// (which replaces store/workspaces.js) does not shadow it.
const real = await import(resolve('../store/workspaces.js') + '?real');

let accessCtx;
let pickedSite = null; // what pickLoginSite finds for the signing-in user
let loginUser = null; // what getUserByEmail finds
mock.module(resolve('../store/workspaces.js'), {
  namedExports: {
    decideSiteAccess: real.decideSiteAccess,
    isBlockedForReadOnly: real.isBlockedForReadOnly,
    isAllowedWithoutProject: real.isAllowedWithoutProject,
    isPlatformAdmin: real.isPlatformAdmin,
    getAccessContext: async () => accessCtx,
    listWorkspacesForUser: async () => [],
    listSharedProjectsForUser: async () => [],
    pickLoginSite: async () => pickedSite,
  },
});

let userStatus;
let siteStatus;
mock.module(resolve('../store/users.js'), {
  namedExports: {
    getUserById: async () => ({ id: 10, role: 'tenant_admin', site_id: 2 }),
    getUserByEmail: async () => loginUser,
    updateUserPassword: async () => { throw new Error('not exercised by these tests'); },
    getUserStatus: async () => userStatus,
  },
});
mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => null, getSiteStatus: async () => siteStatus },
});

const loginRouter = (await import('./login.js')).default;
const { requireAuth } = await import('./login.js');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function runRequireAuth(session, extra = {}) {
  const req = { session, method: 'GET', originalUrl: '/api/overview', ...extra };
  const res = mockRes();
  let nextCalled = false;
  let nextErr;
  await requireAuth(req, res, (e) => { nextCalled = true; nextErr = e; });
  return { req, res, nextCalled, nextErr };
}

const ctx = (over = {}) => ({
  user: { id: 10, role: 'tenant_admin', site_id: 2 },
  site: { id: 2, workspace_id: 7 },
  membership: { role: 'owner' },
  ...over,
});

beforeEach(() => { userStatus = 'active'; siteStatus = 'active'; accessCtx = ctx(); pickedSite = null; loginUser = null; });

describe('requireAuth — workspace membership', () => {
  test('a member of the project\'s workspace passes', async () => {
    const r = await runRequireAuth({ userId: 10, siteId: 2, homeSiteId: 2 });
    assert.equal(r.nextCalled, true);
    assert.equal(r.nextErr, undefined);
    assert.equal(r.req.siteId, 2);
  });

  test('a user with no membership in the active project\'s workspace gets 403', async () => {
    accessCtx = ctx({ site: { id: 9, workspace_id: 8 }, membership: null });
    const r = await runRequireAuth({ userId: 10, siteId: 9, homeSiteId: 2 });
    assert.equal(r.nextCalled, false);
    assert.equal(r.res.statusCode, 403);
  });

  test('being removed from a workspace locks the user out on the very next request', async () => {
    const before = await runRequireAuth({ userId: 10, siteId: 2, homeSiteId: 2 });
    assert.equal(before.nextCalled, true);
    accessCtx = ctx({ membership: null });
    const after = await runRequireAuth({ userId: 10, siteId: 2, homeSiteId: 2 });
    assert.equal(after.res.statusCode, 403);
  });

  test('a platform admin passes into a client\'s project and keeps the company home site', async () => {
    accessCtx = {
      user: { id: 1, role: 'platform_admin', site_id: 1 },
      site: { id: 9, workspace_id: 8 },
      membership: null,
    };
    const r = await runRequireAuth({ userId: 1, siteId: 9, homeSiteId: 1 });
    assert.equal(r.nextCalled, true);
    assert.equal(r.req.siteId, 9);
    assert.equal(r.req.homeSiteId, 1, 'platform gates key on the home site, not the active project');
  });

  test('a session created before workspaces (no homeSiteId) still works', async () => {
    const r = await runRequireAuth({ userId: 10, siteId: 2 });
    assert.equal(r.nextCalled, true);
    assert.equal(r.req.homeSiteId, 2);
  });

  test('a missing user/site row denies rather than passes', async () => {
    accessCtx = null;
    const r = await runRequireAuth({ userId: 10, siteId: 2, homeSiteId: 2 });
    assert.equal(r.nextCalled, false);
    assert.equal(r.res.statusCode, 403);
  });

  test('suspended site and disabled user are still refused first', async () => {
    siteStatus = 'suspended';
    assert.equal((await runRequireAuth({ userId: 10, siteId: 2, homeSiteId: 2 })).res.statusCode, 403);
    siteStatus = 'active';
    userStatus = 'disabled';
    assert.equal((await runRequireAuth({ userId: 10, siteId: 2, homeSiteId: 2 })).res.statusCode, 403);
  });

  test('no session is still 401', async () => {
    const r = await runRequireAuth({});
    assert.equal(r.res.statusCode, 401);
  });
});

describe('POST /workspaces/switch', () => {
  const handler = () => {
    const layer = loginRouter.stack.find((l) => l.route?.path === '/workspaces/switch' && l.route.methods.post);
    if (!layer) throw new Error('switch route not registered');
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  test('switches to a project in a workspace the user belongs to', async () => {
    accessCtx = ctx({ site: { id: 5, workspace_id: 7 } });
    const req = { userId: 10, session: { siteId: 2, homeSiteId: 2 }, body: { siteId: 5 } };
    const res = mockRes();
    await handler()(req, res, (e) => { throw e; });
    assert.equal(res.statusCode, 200);
    assert.equal(req.session.siteId, 5);
    assert.equal(req.session.homeSiteId, 2, 'home site must not change on switch');
  });

  test('refuses another workspace\'s project with 404 and leaves the session alone', async () => {
    accessCtx = ctx({ site: { id: 9, workspace_id: 8 }, membership: null });
    const req = { userId: 10, session: { siteId: 2, homeSiteId: 2 }, body: { siteId: 9 } };
    const res = mockRes();
    await handler()(req, res, (e) => { throw e; });
    assert.equal(res.statusCode, 404);
    assert.equal(req.session.siteId, 2);
  });

  test('rejects a missing or non-numeric siteId', async () => {
    for (const body of [{}, { siteId: 'abc' }, { siteId: -1 }, { siteId: 1.5 }]) {
      const res = mockRes();
      await handler()({ userId: 10, session: { siteId: 2 }, body }, res, (e) => { throw e; });
      assert.equal(res.statusCode, 400);
    }
  });
});

describe('requireAuth — read-only members', () => {
  const asMember = () => { accessCtx = ctx({ membership: { role: 'member' } }); };
  const run = (method, originalUrl) => runRequireAuth({ userId: 10, siteId: 2, homeSiteId: 2 }, { method, originalUrl });

  test('a read-only member can read everything', async () => {
    asMember();
    const r = await run('GET', '/api/overview?from=2026-01-01');
    assert.equal(r.nextCalled, true);
  });

  test('a read-only member cannot change anything, so no write route has to remember to check', async () => {
    asMember();
    for (const [m, url] of [['POST', '/api/growth-targets'], ['PUT', '/api/growth-targets'], ['DELETE', '/api/mcp-tokens/3'], ['PATCH', '/api/anything'], ['POST', '/api/drafts/9/approve']]) {
      const r = await run(m, url);
      assert.equal(r.nextCalled, false, `${m} ${url}`);
      assert.equal(r.res.statusCode, 403, `${m} ${url}`);
      assert.match(r.res.body.error, /read-only/i);
    }
  });

  test('but they can still do personal things: switch project, change password, sign out, make a workspace of their own', async () => {
    asMember();
    for (const [m, url] of [['POST', '/api/workspaces/switch'], ['POST', '/api/change-password'], ['POST', '/api/logout'], ['POST', '/api/workspaces'], ['POST', '/api/verify-password']]) {
      assert.equal((await run(m, url)).nextCalled, true, `${m} ${url}`);
    }
  });

  test('admins and owners are not affected', async () => {
    for (const role of ['admin', 'owner']) {
      accessCtx = ctx({ membership: { role } });
      assert.equal((await run('POST', '/api/workspaces/7/projects')).nextCalled, true, role);
    }
  });

  test('a platform admin is never read-only, even without a membership row', async () => {
    accessCtx = ctx({ user: { id: 1, role: 'platform_admin', site_id: 1 }, membership: null, site: { id: 2, workspace_id: 7 } });
    assert.equal((await run('POST', '/api/workspaces/7/projects')).nextCalled, true);
  });
});

describe('requireAuth — access to one project', () => {
  const run = (method, originalUrl) => runRequireAuth({ userId: 20, siteId: 40, homeSiteId: 40 }, { method, originalUrl });
  const projectOnly = (role) => { accessCtx = ctx({ user: { id: 20, role: 'tenant_member', site_id: 40 }, site: { id: 40, workspace_id: 8 }, membership: null, projectMembership: { role } }); };

  test('a person with project access gets in, with no workspace membership at all', async () => {
    projectOnly('admin');
    const r = await run('GET', '/api/overview');
    assert.equal(r.nextCalled, true);
  });

  test('without the project grant the same person is refused (removal locks them out on the next request)', async () => {
    projectOnly('admin');
    assert.equal((await run('GET', '/api/overview')).nextCalled, true);
    accessCtx = ctx({ user: { id: 20, role: 'tenant_member', site_id: 40 }, site: { id: 40, workspace_id: 8 }, membership: null, projectMembership: null });
    const r = await run('GET', '/api/overview');
    assert.equal(r.res.statusCode, 403);
  });

  test('read-only project access cannot change anything; a project admin can', async () => {
    projectOnly('member');
    for (const [m, url] of [['POST', '/api/growth-targets'], ['PUT', '/api/anything'], ['DELETE', '/api/drafts/1']]) {
      const r = await run(m, url);
      assert.equal(r.res.statusCode, 403, `${m} ${url}`);
    }
    assert.equal((await run('GET', '/api/overview')).nextCalled, true);
    projectOnly('admin');
    assert.equal((await run('POST', '/api/growth-targets')).nextCalled, true);
  });

  test('workspace and project management routes are left to their own role checks, even for a read-only active project', async () => {
    projectOnly('member');
    for (const url of ['/api/workspaces/7/projects', '/api/projects/12/goal']) {
      assert.equal((await run('POST', url)).nextCalled, true, url);
    }
  });
});

// A brand-new account (approved from a sign-up request) has a login and no
// project. It is a real, narrow state: it may reach only the routes that work
// without one, and must never be mistaken for a project-scoped request.
describe('requireAuth — an account with no project yet', () => {
  const session = { userId: 10, siteId: null, homeSiteId: null };

  test('may list and create workspaces, and reach one workspace or project it has a role in', async () => {
    for (const [method, originalUrl] of [
      ['GET', '/api/workspaces'], ['POST', '/api/workspaces'], ['POST', '/api/workspaces/switch'],
      ['POST', '/api/workspaces/7/projects'], ['GET', '/api/workspaces/7/overview'], ['GET', '/api/projects/9/connect'],
      ['POST', '/api/projects/9/baseline'], ['POST', '/api/logout'], ['POST', '/api/change-password'],
    ]) {
      const r = await runRequireAuth(session, { method, originalUrl });
      assert.equal(r.nextCalled, true, `${method} ${originalUrl} should be allowed`);
      assert.equal(r.req.siteId, null);
      assert.equal(r.req.userId, 10);
    }
  });

  test('is refused on every project data route with a code the app can recognise', async () => {
    for (const originalUrl of ['/api/overview', '/api/sites', '/api/insights', '/api/action-center/drafts', '/api/platform/workspaces', '/api/internal/clients']) {
      const r = await runRequireAuth(session, { method: 'GET', originalUrl });
      assert.equal(r.nextCalled, false, originalUrl);
      assert.equal(r.res.statusCode, 403);
      assert.equal(r.res.body.code, 'NO_PROJECT');
    }
  });

  test('cannot slip a data route past the allowlist with a look-alike path or a query string', async () => {
    for (const originalUrl of ['/api/workspaces-evil', '/api/workspacesX', '/api/projects/x/connect', '/api/projects', '/api/workspaces/7evil', '/api/overview?next=/api/workspaces']) {
      const r = await runRequireAuth(session, { method: 'GET', originalUrl });
      assert.equal(r.nextCalled, false, originalUrl);
    }
  });

  test('GET and POST /workspaces only — not a PUT or DELETE on the collection', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      assert.equal((await runRequireAuth(session, { method, originalUrl: '/api/workspaces' })).nextCalled, false, method);
    }
  });

  test('a disabled account is refused even on an allowed route', async () => {
    userStatus = 'disabled';
    const r = await runRequireAuth(session, { method: 'GET', originalUrl: '/api/workspaces' });
    assert.equal(r.nextCalled, false);
    assert.equal(r.res.statusCode, 403);
  });

  test('no session at all is still a 401', async () => {
    const r = await runRequireAuth({}, { method: 'GET', originalUrl: '/api/workspaces' });
    assert.equal(r.nextCalled, false);
    assert.equal(r.res.statusCode, 401);
  });
});

describe('POST /login — accounts with and without a project', () => {
  const login = async (body) => {
    const layer = loginRouter.stack.find((l) => l.route?.path === '/login' && l.route.methods.post);
    const req = { body, session: {} };
    const res = mockRes();
    await layer.route.stack[0].handle(req, res, (e) => { if (e) throw e; });
    return { req, res };
  };

  test('a new account (no home site, nothing to land in) signs in with no active project', async () => {
    loginUser = { id: 30, email: 'new@client.test', site_id: null, password_hash: await bcrypt.hash('correct-horse', 4) };
    pickedSite = null;
    const { req, res } = await login({ email: 'new@client.test', password: 'correct-horse' });
    assert.equal(res.statusCode, 200);
    assert.equal(req.session.userId, 30);
    assert.equal(req.session.siteId, null);
    assert.equal(req.session.homeSiteId, null);
  });

  test('an account that HAD a home project but can reach nothing is still refused', async () => {
    loginUser = { id: 31, email: 'removed@client.test', site_id: 5, password_hash: await bcrypt.hash('correct-horse', 4) };
    pickedSite = null;
    const { req, res } = await login({ email: 'removed@client.test', password: 'correct-horse' });
    assert.equal(res.statusCode, 403);
    assert.equal(req.session.userId, undefined);
  });

  test('a wrong password never creates a session, project or not', async () => {
    loginUser = { id: 30, email: 'new@client.test', site_id: null, password_hash: await bcrypt.hash('correct-horse', 4) };
    const { req, res } = await login({ email: 'new@client.test', password: 'wrong' });
    assert.equal(res.statusCode, 401);
    assert.equal(req.session.userId, undefined);
  });

  test('an ordinary account lands in its project as before', async () => {
    loginUser = { id: 10, email: 'a@client.test', site_id: 2, password_hash: await bcrypt.hash('correct-horse', 4) };
    pickedSite = 2;
    const { req, res } = await login({ email: 'a@client.test', password: 'correct-horse' });
    assert.equal(res.statusCode, 200);
    assert.equal(req.session.siteId, 2);
    assert.equal(req.session.homeSiteId, 2);
  });
});
