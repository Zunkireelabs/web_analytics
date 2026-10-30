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

mock.module(resolve('../store/users.js'), {
  namedExports: {
    getUserById: async (id) => users[id] || null,
    getUserByEmail: async (email) => Object.values(users).find((u) => u.email === email) || null,
    updateUserPassword: async () => { throw new Error('not exercised'); },
    getUserStatus: async () => 'active',
  },
});
mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => null, getSiteStatus: async () => 'active' } });
mock.module(resolve('../store/user-invitations.js'), {
  namedExports: {
    createInvitation: async (o) => { calls.invitations.push(o); return { id: 99, token: 't0ken', expires_at: 'soon' }; },
    acceptInvitation: async () => null,
  },
});
mock.module(resolve('../report/email.js'), {
  namedExports: {
    sendInvitationEmail: async (o) => { calls.emails.push(o); return true; },
    sendContactLeadEmail: async () => true,
    sendPasswordResetEmail: async () => true,
    sendSignupReceivedEmail: async () => true, sendLoginCodeEmail: async () => true,
    sendSignupStaffNotice: async () => true,
  },
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

const router = (await import('./projects.js')).default;
const { autoPickProperties } = await import('./projects.js');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function call(method, path, { userId, params = {}, body = {}, query = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  const req = { userId, siteId: ADMIZZ, params, body, query, session: {}, protocol: 'https', get: () => 'app.example.com' };
  const res = mockRes();
  for (const l of layer.route.stack.slice(1)) {
    let proceeded = false;
    await l.handle(req, res, (err) => { if (err) throw err; proceeded = true; });
    if (!proceeded) break;
  }
  return res;
}
const P = (siteId, extra = {}) => ({ siteId: String(siteId), ...extra });

beforeEach(() => {
  resetCalls();
  users = {
    [PLATFORM]: { id: PLATFORM, email: 'staff@zunkiree.test', role: 'platform_admin', site_id: 1 },
    [WSADMIN]: { id: WSADMIN, email: 'team@zunkiree.test', role: 'tenant_admin', site_id: 1, wsMember: 'admin' },
    [PADMIN]: { id: PADMIN, email: 'admizz@client.test', role: 'tenant_admin', site_id: ADMIZZ },
    [PREAD]: { id: PREAD, email: 'viewer@client.test', role: 'tenant_member', site_id: ADMIZZ },
    [STRANGER]: { id: STRANGER, email: 'nobody@else.test', role: 'tenant_admin', site_id: 9 },
    [EXISTING]: { id: EXISTING, email: 'existing@client.test', role: 'tenant_admin', site_id: 9 },
    [OWNER]: { id: OWNER, email: 'owner@zunkiree.test', role: 'tenant_admin', site_id: 1, wsMember: 'owner' },
  };
  access = {
    [`${PADMIN}:${ADMIZZ}`]: { projectRole: 'admin' },
    [`${PREAD}:${ADMIZZ}`]: { projectRole: 'member' },
    [`${WSADMIN}:${ADMIZZ}`]: { membershipRole: 'admin' }, [`${WSADMIN}:${CHAYCE}`]: { membershipRole: 'admin' },
    [`${OWNER}:${ADMIZZ}`]: { membershipRole: 'owner' },
  };
  wsRoles = { [`${OWNER}:9`]: 'admin', [`${OWNER}:10`]: 'member' };
});

const ROUTES = [
  ['get', '/projects/:siteId/overview'], ['put', '/projects/:siteId/goal'], ['get', '/projects/:siteId/tokens'], ['post', '/projects/:siteId/tokens'],
  ['delete', '/projects/:siteId/tokens/:tokenId'], ['get', '/projects/:siteId/members'], ['post', '/projects/:siteId/members'],
  ['patch', '/projects/:siteId/members/:userId'], ['delete', '/projects/:siteId/members/:userId'], ['post', '/projects/:siteId/transfer'],
];

describe('who can reach a project at all', () => {
  test('a stranger gets 404 on every route: the project is not confirmed to exist', async () => {
    for (const [m, path] of ROUTES) {
      const res = await call(m, path, { userId: STRANGER, params: P(ADMIZZ, { tokenId: '31', userId: String(PREAD) }), body: { email: 'a@b.co' } });
      assert.equal(res.statusCode, 404, `${m} ${path}`);
    }
    assert.deepEqual(calls.goals, []); assert.deepEqual(calls.tokens, []); assert.deepEqual(calls.projectMembers, []);
  });

  test('access to Admizz does not reach Chayce, a project of the same workspace', async () => {
    for (const [m, path] of ROUTES) {
      const res = await call(m, path, { userId: PADMIN, params: P(CHAYCE, { tokenId: '31', userId: String(PREAD) }), body: { email: 'a@b.co' } });
      assert.equal(res.statusCode, 404, `${m} ${path}`);
    }
    assert.deepEqual(calls.goals, []); assert.deepEqual(calls.revoked, []); assert.deepEqual(calls.projectMembers, []);
  });

  test('a non-numeric project id is a 404', async () => {
    assert.equal((await call('get', '/projects/:siteId/overview', { userId: PADMIN, params: P('abc') })).statusCode, 404);
  });
});

describe('a read-only project member', () => {
  test('can look at the project: overview and who has access', async () => {
    const o = await call('get', '/projects/:siteId/overview', { userId: PREAD, params: P(ADMIZZ) });
    assert.equal(o.statusCode, 200);
    assert.equal(o.body.yourRole, 'member');
    assert.equal(o.body.projects.length, 1);
    assert.equal(o.body.projects[0].goal.goal, 'enquiries');
    assert.equal(o.body.projects[0].health.status, 'healthy');
    assert.equal(o.body.activity[0].text, 'set a goal for Admizz Education');
    assert.equal((await call('get', '/projects/:siteId/members', { userId: PREAD, params: P(ADMIZZ) })).statusCode, 200);
  });

  test('cannot change anything or see tokens', async () => {
    const goal = { goal: 'enquiries', growth: 'fast', months: 6 };
    assert.equal((await call('put', '/projects/:siteId/goal', { userId: PREAD, params: P(ADMIZZ), body: goal })).statusCode, 403);
    assert.equal((await call('get', '/projects/:siteId/tokens', { userId: PREAD, params: P(ADMIZZ) })).statusCode, 403);
    assert.equal((await call('post', '/projects/:siteId/tokens', { userId: PREAD, params: P(ADMIZZ), body: {} })).statusCode, 403);
    assert.equal((await call('post', '/projects/:siteId/members', { userId: PREAD, params: P(ADMIZZ), body: { email: 'a@b.co' } })).statusCode, 403);
    assert.equal((await call('delete', '/projects/:siteId/members/:userId', { userId: PREAD, params: P(ADMIZZ, { userId: String(PADMIN) }) })).statusCode, 403);
    assert.deepEqual(calls.goals, []); assert.deepEqual(calls.tokens, []); assert.deepEqual(calls.removals, []);
  });
});

describe('a project admin', () => {
  test('sets the goal of their own project; a bad goal is a 400', async () => {
    const ok = await call('put', '/projects/:siteId/goal', { userId: PADMIN, params: P(ADMIZZ), body: { goal: 'ai_answers', growth: 'fast', months: 6 } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(calls.goals[0], { siteId: ADMIZZ, goal: 'ai_answers', goals: ['ai_answers'], growth: 'fast', months: 6, customText: null, userId: PADMIN });
    assert.equal((await call('put', '/projects/:siteId/goal', { userId: PADMIN, params: P(ADMIZZ), body: { goal: 'x' } })).statusCode, 400);
    assert.equal(calls.goals.length, 1);
  });

  test('creates, lists and revokes tokens for their project only', async () => {
    const list = await call('get', '/projects/:siteId/tokens', { userId: PADMIN, params: P(ADMIZZ) });
    assert.equal(list.body[0].site_name, 'Admizz Education');
    const made = await call('post', '/projects/:siteId/tokens', { userId: PADMIN, params: P(ADMIZZ), body: { label: ' Claude ', permissionLevel: 'ai_actions' } });
    assert.equal(made.statusCode, 201);
    assert.deepEqual(calls.tokens[0], { siteId: ADMIZZ, label: 'Claude', createdBy: PADMIN, permissionLevel: 'ai_actions' });
    assert.equal((await call('post', '/projects/:siteId/tokens', { userId: PADMIN, params: P(ADMIZZ), body: { permissionLevel: 'root' } })).statusCode, 400);
    assert.equal((await call('delete', '/projects/:siteId/tokens/:tokenId', { userId: PADMIN, params: P(ADMIZZ, { tokenId: '31' }) })).statusCode, 200);
    assert.equal((await call('delete', '/projects/:siteId/tokens/:tokenId', { userId: PADMIN, params: P(ADMIZZ, { tokenId: '999' }) })).statusCode, 404);
    assert.deepEqual(calls.revoked[0], [ADMIZZ, 31]);
  });

  test('gives an existing account access to their project only', async () => {
    const res = await call('post', '/projects/:siteId/members', { userId: PADMIN, params: P(ADMIZZ), body: { email: 'existing@client.test', role: 'member' } });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls.projectMembers, [[ADMIZZ, EXISTING, 'member', PADMIN]]);
  });

  test('invites a new email to their project, and the email names the project, never the workspace', async () => {
    const res = await call('post', '/projects/:siteId/members', { userId: PADMIN, params: P(ADMIZZ), body: { email: ' New@Client.test ', role: 'admin' } });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls.invitations[0], {
      siteId: ADMIZZ, email: 'new@client.test', role: 'tenant_admin', invitedBy: PADMIN, workspaceId: 8, projectSiteIds: [ADMIZZ], projectRole: 'admin',
    });
    assert.equal(calls.emails[0].siteName, 'Admizz Education');
    assert.doesNotMatch(JSON.stringify(calls.emails[0]), /Zunkiree Labs/);
  });

  test('can never grant ownership or an unknown role', async () => {
    assert.equal((await call('post', '/projects/:siteId/members', { userId: PADMIN, params: P(ADMIZZ), body: { email: 'a@b.co', role: 'owner' } })).statusCode, 400);
    assert.equal((await call('post', '/projects/:siteId/members', { userId: PADMIN, params: P(ADMIZZ), body: { email: 'a@b.co', role: 'root' } })).statusCode, 400);
    assert.deepEqual(calls.invitations, []);
  });

  test('changes and removes project-level access, but a workspace member is not theirs to touch', async () => {
    assert.equal((await call('patch', '/projects/:siteId/members/:userId', { userId: PADMIN, params: P(ADMIZZ, { userId: String(PREAD) }), body: { role: 'admin' } })).statusCode, 200);
    assert.deepEqual(calls.roleUpdates, [[ADMIZZ, PREAD, 'admin']]);
    assert.equal((await call('patch', '/projects/:siteId/members/:userId', { userId: PADMIN, params: P(ADMIZZ, { userId: String(PREAD) }), body: { role: 'owner' } })).statusCode, 400);
    assert.equal((await call('delete', '/projects/:siteId/members/:userId', { userId: PADMIN, params: P(ADMIZZ, { userId: String(PREAD) }) })).statusCode, 200);
    assert.deepEqual(calls.removals, [[ADMIZZ, PREAD]]);
    // WSADMIN has no project-level row on Admizz (their access is the workspace), so it is a 404 here.
    assert.equal((await call('delete', '/projects/:siteId/members/:userId', { userId: PADMIN, params: P(ADMIZZ, { userId: String(WSADMIN) }) })).statusCode, 404);
    assert.equal(calls.removals.length, 1);
  });

  test('an already-listed person is a 409, not a duplicate', async () => {
    users[EXISTING] = { ...users[EXISTING], wsMember: 'member' };
    const res = await call('post', '/projects/:siteId/members', { userId: PADMIN, params: P(ADMIZZ), body: { email: 'existing@client.test', role: 'member' } });
    assert.equal(res.statusCode, 409);
  });
});

describe('workspace admins and the platform admin reach every project of their workspace', () => {
  test('a workspace admin manages Chayce and Admizz alike', async () => {
    for (const site of [ADMIZZ, CHAYCE]) {
      const res = await call('put', '/projects/:siteId/goal', { userId: WSADMIN, params: P(site), body: { goal: 'enquiries', growth: 'fast', months: 6 } });
      assert.equal(res.statusCode, 200, `site ${site}`);
    }
    assert.deepEqual(calls.goals.map((g) => g.siteId), [ADMIZZ, CHAYCE]);
  });

  test('the platform admin does too, with no membership at all', async () => {
    assert.equal((await call('get', '/projects/:siteId/tokens', { userId: PLATFORM, params: P(CHAYCE) })).statusCode, 200);
    assert.equal((await call('post', '/projects/:siteId/members', { userId: PLATFORM, params: P(CHAYCE), body: { email: 'new@client.test', role: 'admin' } })).statusCode, 201);
    assert.equal(calls.invitations[0].siteId, CHAYCE);
  });
});

describe('POST /projects/:siteId/transfer', () => {
  const transfer = (userId, toWorkspaceId, extra = {}, site = ADMIZZ) => call('post', '/projects/:siteId/transfer', { userId, params: P(site), body: { toWorkspaceId, ...extra } });

  test('an owner moves the project into a workspace where they are an admin, keeping everyone\'s access by default', async () => {
    const res = await transfer(OWNER, 9);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.transfers, [{ siteId: ADMIZZ, toWorkspaceId: 9, keepAccess: true, createdBy: OWNER }]);
    assert.deepEqual(res.body.keptAccess, ['admizz@client.test']);
    assert.ok(calls.audit.includes('project.transferred'));
  });

  test('keepAccess can be turned off', async () => {
    await transfer(OWNER, 9, { keepAccess: false });
    assert.equal(calls.transfers[0].keepAccess, false);
  });

  test('a project admin or a workspace admin cannot transfer; only an owner or the platform admin', async () => {
    assert.equal((await transfer(PADMIN, 9)).statusCode, 403);
    assert.equal((await transfer(WSADMIN, 9)).statusCode, 403);
    assert.equal((await transfer(PREAD, 9)).statusCode, 403);
    assert.deepEqual(calls.transfers, []);
    assert.equal((await transfer(PLATFORM, 9)).statusCode, 200);
  });

  test('the target must be a workspace the person admins: a read-only or unknown one is a 404', async () => {
    assert.equal((await transfer(OWNER, 10)).statusCode, 404); // only a member there
    assert.equal((await transfer(OWNER, 77)).statusCode, 404); // no access at all
    assert.deepEqual(calls.transfers, []);
  });

  test('moving a project into the workspace it is already in is refused, and a missing target is a 400', async () => {
    wsRoles[`${OWNER}:8`] = 'admin';
    assert.equal((await transfer(OWNER, 8)).statusCode, 400);
    assert.equal((await call('post', '/projects/:siteId/transfer', { userId: OWNER, params: P(ADMIZZ), body: {} })).statusCode, 400);
    assert.deepEqual(calls.transfers, []);
  });
});

describe('connecting a project', () => {
  test('only a project admin can read the connect lists or connect anything', async () => {
    for (const [method, path] of [['get', '/projects/:siteId/connect'], ['post', '/projects/:siteId/connect/google'], ['post', '/projects/:siteId/connect/github'], ['post', '/projects/:siteId/baseline']]) {
      assert.equal((await call(method, path, { userId: PREAD, params: P(ADMIZZ) })).statusCode, 403, `${path} as read-only`);
      assert.equal((await call(method, path, { userId: STRANGER, params: P(ADMIZZ) })).statusCode, 404, `${path} as a stranger`);
    }
  });
  test('Google needs a real Search Console property and a numeric GA4 id from the lists', async () => {
    const bad = (body) => call('post', '/projects/:siteId/connect/google', { userId: PLATFORM, params: P(ADMIZZ), body });
    assert.equal((await bad({ gscProperty: 'admizz.com', ga4PropertyId: '123' })).statusCode, 400);
    assert.equal((await bad({ gscProperty: 'sc-domain:admizz.com', ga4PropertyId: 'properties/123' })).statusCode, 400);
    assert.equal((await bad({})).statusCode, 400);
  });
  test('a repository the GitHub app cannot reach is refused, with where to fix it', async () => {
    const res = await call('post', '/projects/:siteId/connect/github', { userId: PLATFORM, params: P(ADMIZZ), body: { repoOwner: 'someone', repoName: 'elses-repo' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /cannot reach that repository/);
    assert.equal(res.body.installUrl, 'https://github.com/apps/superrank/installations/new');
  });
  test('names that are not repository names are refused before anything is looked up', async () => {
    for (const body of [{ repoOwner: 'a b', repoName: 'x' }, { repoOwner: 'a', repoName: '../x' }, {}]) {
      assert.equal((await call('post', '/projects/:siteId/connect/github', { userId: PLATFORM, params: P(ADMIZZ), body })).statusCode, 400);
    }
  });
  test('a stage branch with characters a branch cannot have is refused', async () => {
    const res = await call('post', '/projects/:siteId/connect/github', { userId: PLATFORM, params: P(ADMIZZ), body: { repoOwner: 'Zunkireelabs', repoName: 'admizz-web-dev', prTargetBranch: 'sta ge;rm' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /characters a branch cannot have/);
  });
  test('the baseline refuses to run before Google is connected, and says why', async () => {
    // Chayce's fixture has no Search Console / Analytics property: a baseline now
    // would be built from nothing, so it must be a 409 and must not start.
    const res = await call('post', '/projects/:siteId/baseline', { userId: WSADMIN, params: P(CHAYCE) });
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /Connect Google Search Console and Analytics first/);
    assert.equal(calls.audit.includes('tenant.baseline_started'), false);
  });
});

beforeEach(() => { ownGoogle = null; savedConnections = []; baselineLock = null; });

describe('which Google properties a person can see or attach', () => {
  test('a client with NO Google connection of their own sees none of the shared account\'s properties', async () => {
    const res = await call('get', '/projects/:siteId/connect', { userId: PADMIN, params: P(ADMIZZ) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.githubRestricted, true);
    assert.equal(res.body.google.connected, false);
    assert.deepEqual(res.body.google.searchConsole, []);
    assert.deepEqual(res.body.google.analytics, []);
    assert.equal(JSON.stringify(res.body).includes('other-client'), false);
    assert.equal(JSON.stringify(res.body).includes('admizz-web-dev'), false);
    // GitHub's repos (every client's) are their own route, and a client gets none of them
    const gh = await call('get', '/projects/:siteId/connect/github', { userId: PADMIN, params: P(ADMIZZ) });
    assert.equal(gh.body.restricted, true);
    assert.deepEqual(gh.body.repos, []);
    assert.equal(res.body.state.google.gscProperty, 'sc-domain:admizz.com'); // their own project's state is still shown
  });
  test('a client WITH their own connection sees exactly what that account sees, and never another client\'s', async () => {
    ownGoogle = { google_email: 'owner@admizz.com' };
    const res = await call('get', '/projects/:siteId/connect', { userId: PADMIN, params: P(ADMIZZ) });
    assert.equal(res.body.google.connected, true);
    assert.equal(res.body.google.account, 'owner@admizz.com');
    assert.deepEqual(res.body.google.searchConsole.map((r) => r.property), ['sc-domain:admizz.com']);
    assert.deepEqual(res.body.google.analytics.map((r) => r.propertyId), ['111']);
    assert.equal(JSON.stringify(res.body).includes('other-client'), false);
  });
  test('the platform admin sees the shared lists only when they ask for them, and only without a connection of their own', async () => {
    const plain = await call('get', '/projects/:siteId/connect', { userId: PLATFORM, params: P(ADMIZZ) });
    assert.deepEqual(plain.body.google.searchConsole, []);
    assert.equal(plain.body.google.sharedAvailable, true);
    const shared = await call('get', '/projects/:siteId/connect', { userId: PLATFORM, params: P(ADMIZZ), query: { shared: '1' } });
    assert.equal(shared.body.google.usingShared, true);
    assert.equal(shared.body.google.searchConsole.length, 2);
    const gh = await call('get', '/projects/:siteId/connect/github', { userId: PLATFORM, params: P(ADMIZZ) });
    assert.deepEqual(gh.body.repos.map((r) => r.fullName), ['Zunkireelabs/admizz-web-dev']);
    ownGoogle = { google_email: 'owner@admizz.com' };
    const own = await call('get', '/projects/:siteId/connect', { userId: PLATFORM, params: P(ADMIZZ), query: { shared: '1' } });
    assert.equal(own.body.google.usingShared, false); // a project's own connection always wins
    assert.equal(own.body.google.searchConsole.length, 1);
  });
  test('without a connection a client cannot save Google properties, even ones that look valid', async () => {
    const g = await call('post', '/projects/:siteId/connect/google', { userId: PADMIN, params: P(ADMIZZ), body: { gscProperty: 'sc-domain:other-client.com', ga4PropertyId: '999' } });
    assert.equal(g.statusCode, 403);
    assert.equal(g.body.code, 'GOOGLE_NOT_CONNECTED');
  });
  test('with a connection, a property that account cannot reach is refused, however the request words it', async () => {
    ownGoogle = { google_email: 'owner@admizz.com' };
    for (const body of [
      { gscProperty: 'sc-domain:other-client.com', ga4PropertyId: '111' },
      { gscProperty: 'sc-domain:admizz.com', ga4PropertyId: '999' },
      { gscProperty: 'sc-domain:other-client.com', ga4PropertyId: '999' },
    ]) {
      const res = await call('post', '/projects/:siteId/connect/google', { userId: PADMIN, params: P(ADMIZZ), body });
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /not one your Google account can access/);
    }
  });
  test('a baseline that is already running is followed, never started a second time', async () => {
    baselineLock = { acquired_at: '2026-10-27T05:00:00Z' };
    const before = calls.audit.length;
    const res = await call('post', '/projects/:siteId/baseline', { userId: PADMIN, params: P(ADMIZZ) });
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.running, true);
    assert.equal(calls.audit.length, before, 'no second start is recorded');
    const status = await call('get', '/projects/:siteId/baseline', { userId: PADMIN, params: P(ADMIZZ) });
    assert.equal(status.body.status, 'running');
  });
  test('a client cannot connect GitHub from the shared app, and cannot re-run a finished baseline', async () => {
    const h = await call('post', '/projects/:siteId/connect/github', { userId: PADMIN, params: P(ADMIZZ), body: { repoOwner: 'Zunkireelabs', repoName: 'admizz-web-dev' } });
    assert.equal(h.statusCode, 403);
    assert.equal(h.body.code, 'STAFF_CONNECT');
    SITES[ADMIZZ].onboarded_at = '2026-10-01T00:00:00Z';
    try {
      const again = await call('post', '/projects/:siteId/baseline', { userId: PADMIN, params: P(ADMIZZ) });
      assert.equal(again.statusCode, 403);
      assert.equal(again.body.code, 'STAFF_CONNECT');
    } finally { delete SITES[ADMIZZ].onboarded_at; }
  });
});

describe('autoPickProperties — saved without asking only when there is nothing to choose', () => {
  const sc = (n) => Array.from({ length: n }, (_, i) => ({ property: `sc-domain:site${i}.com` }));
  const ga = (n) => Array.from({ length: n }, (_, i) => ({ propertyId: String(100 + i) }));
  test('one of each is saved', () => {
    assert.deepEqual(autoPickProperties({ searchConsole: sc(1), analytics: ga(1) }), { gscProperty: 'sc-domain:site0.com', ga4PropertyId: '100' });
  });
  test('several of either means the person is asked', () => {
    assert.deepEqual(autoPickProperties({ searchConsole: sc(2), analytics: ga(1) }), { gscProperty: null, ga4PropertyId: '100' });
    assert.deepEqual(autoPickProperties({ searchConsole: sc(1), analytics: ga(3) }), { gscProperty: 'sc-domain:site0.com', ga4PropertyId: null });
  });
  test('none, or a list that failed to load, is never saved', () => {
    assert.deepEqual(autoPickProperties({ searchConsole: [], analytics: [] }), { gscProperty: null, ga4PropertyId: null });
    assert.deepEqual(autoPickProperties({ searchConsole: { error: 'x' }, analytics: { error: 'y' } }), { gscProperty: null, ga4PropertyId: null });
    assert.deepEqual(autoPickProperties(null), { gscProperty: null, ga4PropertyId: null });
  });
});

describe('the Google connect link and its callback', () => {
  const was = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, key: process.env.SECRETS_ENCRYPTION_KEY, cid: process.env.GOOGLE_CONNECT_CLIENT_ID, csecret: process.env.GOOGLE_CONNECT_CLIENT_SECRET };
  beforeEach(() => {
    delete process.env.GOOGLE_CONNECT_CLIENT_ID; delete process.env.GOOGLE_CONNECT_CLIENT_SECRET; // a developer's .env must not leak in
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });
  const restore = () => { for (const [k, v] of [['GOOGLE_OAUTH_CLIENT_ID', was.id], ['GOOGLE_OAUTH_CLIENT_SECRET', was.secret], ['SECRETS_ENCRYPTION_KEY', was.key], ['GOOGLE_CONNECT_CLIENT_ID', was.cid], ['GOOGLE_CONNECT_CLIENT_SECRET', was.csecret]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

  async function callback(query, session) {
    const layer = router.stack.find((l) => l.route?.path === '/google/callback' && l.route.methods.get);
    const req = { query, session, protocol: 'https', get: () => 'app.example.com' };
    const res = { redirected: null, redirect(u) { this.redirected = u; return this; }, status() { return this; }, json() { return this; } };
    await layer.route.stack[0].handle(req, res, (e) => { if (e) throw e; });
    return { res, req };
  }

  test('start hands back a Google address carrying a one-time state, and remembers it for this session only', async () => {
    try {
      const res = await call('get', '/projects/:siteId/connect/google/start', { userId: PADMIN, params: P(ADMIZZ) });
      assert.equal(res.statusCode, 200);
      const url = new URL(res.body.url);
      assert.equal(url.hostname, 'accounts.google.com');
      assert.equal(url.searchParams.get('access_type'), 'offline');
      assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.com/api/google/callback');
      assert.match(url.searchParams.get('scope'), /webmasters/);
      assert.match(url.searchParams.get('scope'), /analytics\.readonly/);
      assert.ok(url.searchParams.get('state').length >= 24);
    } finally { restore(); }
  });
  test('start says so plainly when Google sign-in or the storage key is not set up', async () => {
    try {
      // Neither the connect client nor the shared fallback may be set, whatever the developer's .env holds.
      delete process.env.GOOGLE_CONNECT_CLIENT_ID; delete process.env.GOOGLE_CONNECT_CLIENT_SECRET;
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      assert.equal((await call('get', '/projects/:siteId/connect/google/start', { userId: PADMIN, params: P(ADMIZZ) })).body.code, 'NOT_CONFIGURED');
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'x'; process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'y';
      delete process.env.SECRETS_ENCRYPTION_KEY;
      assert.equal((await call('get', '/projects/:siteId/connect/google/start', { userId: PADMIN, params: P(ADMIZZ) })).body.code, 'NO_ENCRYPTION_KEY');
    } finally { restore(); }
  });
  test('only a project admin can start it', async () => {
    try {
      assert.equal((await call('get', '/projects/:siteId/connect/google/start', { userId: PREAD, params: P(ADMIZZ) })).statusCode, 403);
      assert.equal((await call('get', '/projects/:siteId/connect/google/start', { userId: STRANGER, params: P(ADMIZZ) })).statusCode, 404);
    } finally { restore(); }
  });
  test('a callback with the wrong state, no pending sign-in, someone else\'s session, or a stale one stores nothing', async () => {
    try {
      const fresh = () => ({ nonce: 'abc', siteId: ADMIZZ, userId: PADMIN, redirectUri: 'x', at: Date.now() });
      const cases = [
        [{ code: 'c', state: 'WRONG' }, { userId: PADMIN, googleConnect: fresh() }],
        [{ code: 'c', state: 'abc' }, { userId: PADMIN }],
        [{ code: 'c', state: 'abc' }, { userId: PREAD, googleConnect: fresh() }],
        [{ code: 'c', state: 'abc' }, { userId: PADMIN, googleConnect: { ...fresh(), at: Date.now() - 11 * 60 * 1000 } }],
        [{ code: 'c' }, { userId: PADMIN, googleConnect: fresh() }],
      ];
      for (const [query, session] of cases) {
        const { res, req } = await callback(query, session);
        assert.match(res.redirected, /gerror=expired/);
        assert.equal(req.session.googleConnect, undefined, 'the pending sign-in is single use');
      }
      assert.deepEqual(savedConnections, []);
    } finally { restore(); }
  });
  test('cancelling on the Google screen returns to the app with a plain message and stores nothing', async () => {
    try {
      const { res } = await callback({ error: 'access_denied' }, { userId: PADMIN, googleConnect: { nonce: 'abc', siteId: ADMIZZ, userId: PADMIN, redirectUri: 'x', at: Date.now() } });
      assert.match(res.redirected, /gerror=cancelled/);
      assert.deepEqual(savedConnections, []);
    } finally { restore(); }
  });
  test('with no session at all it sends the person to the sign-in page, not an error', async () => {
    try {
      const { res } = await callback({ code: 'c', state: 'abc' }, {});
      assert.equal(res.redirected, '/');
    } finally { restore(); }
  });
});

describe('DELETE /projects/:siteId', () => {
  const del = (userId, siteId, body, extra = {}) => call('delete', '/projects/:siteId', { userId, params: P(siteId), body, ...extra });

  test('the owner deletes a project by typing its exact name; it is soft-deleted, audited, and its Google sign-in removed', async () => {
    const res = await del(OWNER, ADMIZZ, { confirmName: 'Admizz Education' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, true);
    assert.deepEqual(calls.softDeleted, [ADMIZZ]);
    assert.ok(calls.audit.includes('project.deleted'));
  });
  test('the platform admin can too', async () => {
    assert.equal((await del(PLATFORM, ADMIZZ, { confirmName: 'Admizz Education' })).statusCode, 200);
  });
  test('a name that is not exactly right deletes nothing, whatever else is sent', async () => {
    for (const confirmName of ['admizz education', 'Admizz', '', undefined, 'Admizz Education!']) {
      const res = await del(OWNER, ADMIZZ, { confirmName });
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /exact name/);
    }
    assert.deepEqual(calls.softDeleted, []);
  });
  test('surrounding spaces are ignored, nothing else is', async () => {
    assert.equal((await del(OWNER, ADMIZZ, { confirmName: '  Admizz Education  ' })).statusCode, 200);
  });
  test('only an owner: a project admin, a workspace admin and a read-only member are all refused; a stranger sees a 404', async () => {
    for (const userId of [PADMIN, WSADMIN, PREAD]) {
      const res = await del(userId, ADMIZZ, { confirmName: 'Admizz Education' });
      assert.equal(res.statusCode, 403, `user ${userId}`);
    }
    assert.equal((await del(STRANGER, ADMIZZ, { confirmName: 'Admizz Education' })).statusCode, 404);
    assert.deepEqual(calls.softDeleted, []);
  });
  test('the company\'s own project can never be deleted, not even by the platform admin', async () => {
    const res = await del(PLATFORM, 1, { confirmName: 'Zunkiree Labs' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /own project/);
    assert.deepEqual(calls.softDeleted, []);
  });
  test('a project that is already deleted is a 404, not a second delete', async () => {
    SITES[ADMIZZ].status = 'soft_deleted';
    try {
      assert.equal((await del(OWNER, ADMIZZ, { confirmName: 'Admizz Education' })).statusCode, 404);
      assert.deepEqual(calls.softDeleted, []);
    } finally { delete SITES[ADMIZZ].status; }
  });
});
