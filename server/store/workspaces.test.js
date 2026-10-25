import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSiteAccess, isPlatformAdmin, decideMemberChange, effectiveWorkspaceRole, roleAtLeast, tenantRoleForWorkspaceRole,
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
