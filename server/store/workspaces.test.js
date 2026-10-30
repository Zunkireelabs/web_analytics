import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSiteAccess, isPlatformAdmin, decideMemberChange, effectiveWorkspaceRole, roleAtLeast, tenantRoleForWorkspaceRole,
  isBlockedForReadOnly, validateGoal, summarizeProjectHealth, describeActivity, strongerRole, siteRoleFromDecision, planProjectTransfer,
} from './workspaces.js';

const COMPANY = 1; // the company (Zunkiree Labs) site

const member = { id: 10, role: 'tenant_admin', site_id: 2 };
const platformAdmin = { id: 1, role: 'platform_admin', site_id: COMPANY };

describe('isPlatformAdmin', () => {
  test('needs the role AND the company home site', () => {
    assert.equal(isPlatformAdmin(platformAdmin, COMPANY), true);
    // A client user cannot become a platform admin by role alone.
    assert.equal(isPlatformAdmin({ id: 5, role: 'platform_admin', site_id: 2 }, COMPANY), false);
    assert.equal(isPlatformAdmin({ id: 5, role: 'tenant_admin', site_id: COMPANY }, COMPANY), false);
  });

  test('is false when no company site is configured', () => {
    assert.equal(isPlatformAdmin(platformAdmin, undefined), false);
    assert.equal(isPlatformAdmin(platformAdmin, 0), false);
    assert.equal(isPlatformAdmin(platformAdmin, NaN), false);
    assert.equal(isPlatformAdmin(null, COMPANY), false);
  });
});

describe('decideSiteAccess — workspace isolation', () => {
  test('a member reaches a project in their own workspace', () => {
    const d = decideSiteAccess({
      user: member, site: { id: 2, workspace_id: 7 }, membership: { role: 'owner' }, companySiteId: COMPANY,
    });
    assert.deepEqual(d, { allowed: true, via: 'member', role: 'owner' });
  });

  test('a non-member cannot reach another workspace\'s project', () => {
    const d = decideSiteAccess({
      user: member, site: { id: 9, workspace_id: 8 }, membership: null, companySiteId: COMPANY,
    });
    assert.equal(d.allowed, false);
  });

  test('a client user is never treated as the platform admin, even for the company workspace', () => {
    const d = decideSiteAccess({
      user: member, site: { id: COMPANY, workspace_id: 1 }, membership: null, companySiteId: COMPANY,
    });
    assert.equal(d.allowed, false, 'a client must not be able to see Zunkiree Labs');
  });

  test('a platform admin reaches every workspace without a membership row', () => {
    const d = decideSiteAccess({
      user: platformAdmin, site: { id: 9, workspace_id: 8 }, membership: null, companySiteId: COMPANY,
    });
    assert.deepEqual(d, { allowed: true, via: 'platform' });
  });

  test('a site the migration has not reached is only reachable from its own home site', () => {
    const own = decideSiteAccess({ user: member, site: { id: 2, workspace_id: null }, membership: null, companySiteId: COMPANY });
    const other = decideSiteAccess({ user: member, site: { id: 3, workspace_id: null }, membership: null, companySiteId: COMPANY });
    assert.equal(own.allowed, true);
    assert.equal(other.allowed, false);
  });

  test('fails closed on missing input', () => {
    assert.equal(decideSiteAccess({ user: null, site: { id: 2, workspace_id: 7 }, membership: { role: 'owner' } }).allowed, false);
    assert.equal(decideSiteAccess({ user: member, site: null, membership: { role: 'owner' } }).allowed, false);
    assert.equal(decideSiteAccess({}).allowed, false);
  });
});

describe('workspace roles', () => {
  test('roleAtLeast orders member < admin < owner and rejects unknown roles', () => {
    assert.equal(roleAtLeast('owner', 'admin'), true);
    assert.equal(roleAtLeast('admin', 'admin'), true);
    assert.equal(roleAtLeast('member', 'admin'), false);
    assert.equal(roleAtLeast(null, 'member'), false);
    assert.equal(roleAtLeast('owner', 'superuser'), false);
  });

  test('a platform admin is an owner everywhere; anyone else holds exactly their membership role', () => {
    assert.equal(effectiveWorkspaceRole({ user: platformAdmin, membershipRole: null, companySiteId: COMPANY }), 'owner');
    assert.equal(effectiveWorkspaceRole({ user: member, membershipRole: 'admin', companySiteId: COMPANY }), 'admin');
    assert.equal(effectiveWorkspaceRole({ user: member, membershipRole: null, companySiteId: COMPANY }), null);
    assert.equal(effectiveWorkspaceRole({ user: member, membershipRole: 'root', companySiteId: COMPANY }), null);
  });

  test('workspace roles map onto the tenant roles existing per-project checks read', () => {
    assert.equal(tenantRoleForWorkspaceRole('owner'), 'tenant_admin');
    assert.equal(tenantRoleForWorkspaceRole('admin'), 'tenant_admin');
    assert.equal(tenantRoleForWorkspaceRole('member'), 'tenant_member');
  });
});

describe('decideMemberChange', () => {
  const change = (o) => decideMemberChange({ ownerCount: 2, ...o });

  test('a plain member cannot manage anyone', () => {
    assert.equal(change({ actorRole: 'member', targetRole: 'member', newRole: 'admin' }).ok, false);
    assert.equal(change({ actorRole: 'member', targetRole: 'member', newRole: null }).ok, false);
  });

  test('an admin can manage members and admins', () => {
    assert.equal(change({ actorRole: 'admin', targetRole: 'member', newRole: 'admin' }).ok, true);
    assert.equal(change({ actorRole: 'admin', targetRole: 'admin', newRole: 'member' }).ok, true);
    assert.equal(change({ actorRole: 'admin', targetRole: 'member', newRole: null }).ok, true);
  });

  test('only an owner may touch an owner or grant ownership', () => {
    assert.equal(change({ actorRole: 'admin', targetRole: 'owner', newRole: 'member' }).ok, false);
    assert.equal(change({ actorRole: 'admin', targetRole: 'owner', newRole: null }).ok, false);
    assert.equal(change({ actorRole: 'admin', targetRole: 'member', newRole: 'owner' }).ok, false, 'an admin must not promote themselves or others to owner');
    assert.equal(change({ actorRole: 'owner', targetRole: 'member', newRole: 'owner' }).ok, true);
  });

  test('the last owner can be neither demoted nor removed', () => {
    assert.equal(decideMemberChange({ actorRole: 'owner', targetRole: 'owner', newRole: 'admin', ownerCount: 1 }).ok, false);
    assert.equal(decideMemberChange({ actorRole: 'owner', targetRole: 'owner', newRole: null, ownerCount: 1 }).ok, false);
    assert.equal(decideMemberChange({ actorRole: 'owner', targetRole: 'owner', newRole: 'admin', ownerCount: 2 }).ok, true);
  });

  test('rejects an unknown role', () => {
    assert.equal(change({ actorRole: 'owner', targetRole: 'member', newRole: 'root' }).ok, false);
  });
});

describe('isBlockedForReadOnly', () => {
  const base = { via: 'member', role: 'member' };
  test('reads are never blocked', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) assert.equal(isBlockedForReadOnly({ ...base, method, path: '/api/x' }), false);
  });
  test('every other method is blocked for a read-only member', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(isBlockedForReadOnly({ ...base, method, path: '/api/drafts/1' }), true);
  });
  test('personal account actions stay allowed, including with a query string', () => {
    for (const path of ['/api/logout', '/api/workspaces/switch', '/api/workspaces', '/api/change-password', '/api/verify-password', '/api/notifications/3/read', '/api/workspaces/switch?x=1']) {
      assert.equal(isBlockedForReadOnly({ ...base, method: 'POST', path }), false, path);
    }
  });
  test('lookalike paths are not allowed through', () => {
    for (const path of ['/api/logout/../drafts', '/api/workspaces/switchx', '/x/api/logout', '/api/workspacesx', '/api/projects', '/api/projectsx/3/members', '/api/workspaces/abc/members']) {
      assert.equal(isBlockedForReadOnly({ ...base, method: 'POST', path }), true, path);
    }
  });
  test('workspace and project routes are exempt: they check the role of the workspace/project in the URL themselves', () => {
    for (const path of ['/api/workspaces/7/projects', '/api/workspaces/7/members/3', '/api/projects/12/goal', '/api/projects/12/tokens']) {
      assert.equal(isBlockedForReadOnly({ ...base, method: 'POST', path }), false, path);
    }
  });
  test('a read-only person given access to ONE project is read-only too', () => {
    assert.equal(isBlockedForReadOnly({ via: 'project', role: 'member', method: 'DELETE', path: '/api/drafts/9' }), true);
    assert.equal(isBlockedForReadOnly({ via: 'project', role: 'admin', method: 'DELETE', path: '/api/drafts/9' }), false);
    assert.equal(isBlockedForReadOnly({ via: 'project', role: 'member', method: 'GET', path: '/api/drafts' }), false);
  });
  test('only a plain membership as "member" is read-only: admins, owners, platform and legacy are not', () => {
    for (const a of [{ via: 'member', role: 'admin' }, { via: 'member', role: 'owner' }, { via: 'platform' }, { via: 'legacy-home' }, { via: null }]) {
      assert.equal(isBlockedForReadOnly({ ...a, method: 'POST', path: '/api/x' }), false, JSON.stringify(a));
    }
  });
});

describe('validateGoal', () => {
  const ok = { goal: 'google_visitors', growth: 'fast', months: 6 };
  test('accepts every combination the picker offers', () => {
    for (const goal of ['google_visitors', 'enquiries', 'ai_answers', 'key_rankings'])
      for (const growth of ['steady', 'fast', 'ambitious'])
        for (const months of [3, 6, 12]) assert.equal(validateGoal({ goal, growth, months }).ok, true);
  });
  test('coerces months sent as a string', () => assert.equal(validateGoal({ ...ok, months: '12' }).goal.months, 12));
  test('rejects anything else', () => {
    for (const bad of [{ ...ok, goal: 'x' }, { ...ok, growth: 'huge' }, { ...ok, months: 5 }, { ...ok, months: undefined }, {}, null, undefined]) {
      assert.equal(validateGoal(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe('summarizeProjectHealth', () => {
  const now = new Date('2026-10-26T12:00:00Z').getTime();
  const site = { gsc_property: 'sc-domain:a.com', ga4_property_id: '1' };
  const get = (h, key) => h.checks.find((c) => c.key === key);

  test('a connected project with fresh data and no failures is healthy', () => {
    const h = summarizeProjectHealth({ site, dataAsOf: '2026-10-25', now });
    assert.equal(h.status, 'healthy');
    assert.deepEqual(h.checks.map((c) => c.state), ['ok', 'ok', 'ok', 'ok']);
  });
  test('a project that is not connected needs attention and its agents are waiting', () => {
    const h = summarizeProjectHealth({ site: { gsc_property: null, ga4_property_id: null }, dataAsOf: null, now });
    assert.equal(h.status, 'attention');
    assert.equal(get(h, 'search_console').text, 'Not connected');
    assert.equal(get(h, 'data').text, 'No data yet');
    assert.equal(get(h, 'agents').state, 'pending');
  });
  test('search data a few days old is normal; older than five days is flagged', () => {
    assert.equal(get(summarizeProjectHealth({ site, dataAsOf: '2026-10-23', now }), 'data').state, 'ok');
    const stale = get(summarizeProjectHealth({ site, dataAsOf: '2026-10-15', now }), 'data');
    assert.equal(stale.state, 'warn');
    assert.match(stale.text, /11 days ago/);
  });
  test('failed agent runs in the last day are surfaced with a count', () => {
    const h = summarizeProjectHealth({ site, dataAsOf: '2026-10-25', agentFailures24h: 2, now });
    assert.equal(h.status, 'attention');
    assert.equal(get(h, 'agents').text, '2 runs failed in 24h');
    assert.equal(get(summarizeProjectHealth({ site, dataAsOf: '2026-10-25', agentFailures24h: 1, now }), 'agents').text, '1 run failed in 24h');
  });
});

describe('describeActivity', () => {
  const row = (action, metadata = {}, extra = {}) => ({ id: 1, action, actor_email: 'maya@x.test', tenant_name: 'Acme Blog', metadata, created_at: 't', ...extra });
  test('turns audit rows into plain sentences', () => {
    assert.equal(describeActivity(row('workspace.member_added', { email: 'lee@x.test', role: 'member' })).text, 'gave Read-only access to lee@x.test');
    assert.equal(describeActivity(row('workspace.member_invited', { email: 'lee@x.test', role: 'admin' })).text, 'invited lee@x.test as Admin');
    assert.equal(describeActivity(row('workspace.member_role_changed', { newRole: 'admin' })).text, 'changed someone’s access to Admin');
    assert.equal(describeActivity(row('project.goal_set', { goal: 'enquiries' })).text, 'set a goal for Acme Blog');
    assert.equal(describeActivity(row('mcp_token.created', { label: 'Claude' })).text, 'created the API token “Claude” for Acme Blog');
  });
  test('keeps the actor so the screen can say "You"', () => assert.equal(describeActivity(row('workspace.created')).actorEmail, 'maya@x.test'));
  test('returns null for actions a workspace should not see', () => {
    assert.equal(describeActivity(row('tenant.suspended')), null);
    assert.equal(describeActivity(row('user.login')), null);
  });
});

describe('project-level access (decideSiteAccess)', () => {
  const site = { id: 40, workspace_id: 8 };
  const user = { id: 20, role: 'tenant_member', site_id: 40 };
  const decide = (over) => decideSiteAccess({ user, site, membership: null, projectMembership: null, companySiteId: COMPANY, ...over });

  test('access to one project opens that project and nothing else', () => {
    assert.deepEqual(decide({ projectMembership: { role: 'admin' } }), { allowed: true, via: 'project', role: 'admin' });
    // same person, different project of the same workspace: no project membership there, so no access
    assert.equal(decide({ site: { id: 41, workspace_id: 8 } }).allowed, false);
  });
  test('a user with no membership of any kind is denied, even from their old home site', () => {
    assert.equal(decide({}).allowed, false);
  });
  test('workspace membership still wins and the role is the stronger of the two FOR THIS project', () => {
    const d = decide({ membership: { role: 'member' }, projectMembership: { role: 'admin' } });
    assert.deepEqual(d, { allowed: true, via: 'member', role: 'admin' });
    // read-only in the workspace, no project grant on this project: stays read-only
    assert.equal(decide({ membership: { role: 'member' } }).role, 'member');
  });
  test('a platform admin is unaffected', () => {
    assert.deepEqual(decide({ user: platformAdmin }), { allowed: true, via: 'platform' });
  });
  test('a site with no workspace at all falls back to the old home-site rule', () => {
    assert.equal(decide({ site: { id: 40, workspace_id: null } }).via, 'legacy-home');
  });
});

describe('strongerRole / siteRoleFromDecision', () => {
  test('picks the higher role, tolerating a missing one', () => {
    assert.equal(strongerRole('member', 'admin'), 'admin');
    assert.equal(strongerRole('owner', 'admin'), 'owner');
    assert.equal(strongerRole('member', undefined), 'member');
    assert.equal(strongerRole(undefined, 'member'), 'member');
    assert.equal(strongerRole(undefined, undefined), null);
  });
  test('maps a decision to the role project actions are checked against', () => {
    assert.equal(siteRoleFromDecision({ allowed: true, via: 'platform' }), 'owner');
    assert.equal(siteRoleFromDecision({ allowed: true, via: 'project', role: 'admin' }), 'admin');
    assert.equal(siteRoleFromDecision({ allowed: true, via: 'member', role: 'member' }), 'member');
    assert.equal(siteRoleFromDecision({ allowed: false, via: null }), null);
    assert.equal(siteRoleFromDecision(null), null);
    assert.equal(siteRoleFromDecision({ allowed: true, via: 'legacy-home' }), null);
  });
});

describe('describeActivity: project access', () => {
  const row = (action, metadata) => ({ id: 1, action, actor_email: 'a@x.test', tenant_name: 'Admizz Education', metadata, created_at: 't' });
  test('says which project a person was given', () => {
    assert.equal(describeActivity(row('project.member_added', { email: 'v@x.test', role: 'member' })).text, 'gave Read-only access to v@x.test (Admizz Education only)');
    assert.equal(describeActivity(row('project.member_removed', {})).text, 'removed someone’s access to Admizz Education');
  });
});

describe('planProjectTransfer', () => {
  const site = { id: 8862, name: 'Admizz', workspace_id: 3 };
  const source = { id: 3, name: 'Admizz' }; const target = { id: 2, name: 'Zunkiree Labs' };
  const sourceMembers = [{ user_id: 20, role: 'owner', email: 'o@x.test' }, { user_id: 21, role: 'member', email: 'm@x.test' }];
  test('keeps old-workspace people in, as project-only access', () => {
    const plan = planProjectTransfer({ site, source, target, sourceMembers, targetMemberIds: [] });
    assert.deepEqual(plan.grants.map((g) => [g.email, g.projectRole]), [['o@x.test', 'admin'], ['m@x.test', 'member']]);
  });
  test('with keepAccess off nobody is carried over', () => {
    const plan = planProjectTransfer({ site, source, target, sourceMembers, targetMemberIds: [], keepAccess: false });
    assert.deepEqual(plan.grants, []);
    assert.equal(plan.ok, true);
  });
  test('people already in the target are not duplicated, and a same-workspace move is refused', () => {
    assert.deepEqual(planProjectTransfer({ site, source, target, sourceMembers, targetMemberIds: [20] }).alreadyInTarget, ['o@x.test']);
    assert.equal(planProjectTransfer({ site: { ...site, workspace_id: 2 }, source: target, target, sourceMembers, targetMemberIds: [] }).ok, false);
  });
});
