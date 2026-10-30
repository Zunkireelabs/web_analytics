import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planSiteDeletion, describeDeletion } from './delete-site.js';

const site = { id: 8865, name: 'zennly', status: 'active', workspace_id: 4 };
const base = { site, companySiteId: '1', homeUsers: [{ id: 9, email: 'zennly.io@gmail.com', role: 'tenant_admin' }], elsewhere: { 9: { workspaces: 0, projects: 0 } }, workspaceSiteCount: 1 };

describe('planSiteDeletion', () => {
  test('a client site whose only login exists for it can go, and takes its empty workspace', () => {
    const p = planSiteDeletion(base);
    assert.equal(p.ok, true);
    assert.deepEqual(p.deletesLogins, ['zennly.io@gmail.com']);
    assert.equal(p.removesWorkspace, true);
  });
  test('the workspace stays when it holds other projects', () => {
    assert.equal(planSiteDeletion({ ...base, workspaceSiteCount: 3 }).removesWorkspace, false);
  });
  test('the company site is never deletable', () => {
    const p = planSiteDeletion({ ...base, companySiteId: '8865' });
    assert.equal(p.ok, false);
    assert.match(p.problems[0], /company's own site/);
  });
  test('refuses when a login that would be deleted also belongs to another workspace or project', () => {
    for (const other of [{ workspaces: 1, projects: 0 }, { workspaces: 0, projects: 2 }]) {
      const p = planSiteDeletion({ ...base, elsewhere: { 9: other } });
      assert.equal(p.ok, false);
      assert.match(p.problems[0], /Move them first/);
    }
  });
  test('refuses to delete a platform admin login as a side effect', () => {
    const p = planSiteDeletion({ ...base, homeUsers: [{ id: 1, email: 'staff@z.test', role: 'platform_admin' }], elsewhere: { 1: { workspaces: 0, projects: 0 } } });
    assert.equal(p.ok, false);
    assert.match(p.problems[0], /platform admin/);
  });
  test('a missing site is a clear refusal, not a crash', () => {
    assert.equal(planSiteDeletion({ ...base, site: null }).ok, false);
  });
  test('the dry run says what goes and how it can be undone mid-way', () => {
    const text = describeDeletion(planSiteDeletion(base));
    assert.match(text, /Permanently delete "zennly"/);
    assert.match(text, /zennly\.io@gmail\.com/);
    assert.match(text, /can be reactivated/);
  });
});
