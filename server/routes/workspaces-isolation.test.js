import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Route-level isolation for the workspace layer: requireAuth must refuse a
// session whose active project the user has no membership in, and the switch
// endpoint must not let a user move into someone else's workspace.

process.env.COMPANY_SITE_ID = '1';

// The real decision function, loaded under a different URL so the mock below
// (which replaces store/workspaces.js) does not shadow it.
const real = await import(resolve('../store/workspaces.js') + '?real');

let accessCtx;
mock.module(resolve('../store/workspaces.js'), {
  namedExports: {
    decideSiteAccess: real.decideSiteAccess,
    isPlatformAdmin: real.isPlatformAdmin,
    getAccessContext: async () => accessCtx,
    listWorkspacesForUser: async () => [],
    pickLoginSite: async () => null,
  },
});

let userStatus;
let siteStatus;
mock.module(resolve('../store/users.js'), {
  namedExports: {
    getUserById: async () => ({ id: 10, role: 'tenant_admin', site_id: 2 }),
    getUserByEmail: async () => { throw new Error('not exercised by these tests'); },
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

async function runRequireAuth(session) {
  const req = { session };
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

beforeEach(() => { userStatus = 'active'; siteStatus = 'active'; accessCtx = ctx(); });

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
