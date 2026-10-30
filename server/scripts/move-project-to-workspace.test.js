import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planMove, describePlan, canRemoveSource } from './move-project-to-workspace.js';

const site = { id: 8862, name: 'Admizz Education', workspace_id: 3 };
const source = { id: 3, name: 'Admizz Education' };
const target = { id: 1, name: 'Zunkiree Labs' };
const sourceMembers = [{ user_id: 20, role: 'owner', email: 'admizzedu@gmail.com' }, { user_id: 21, role: 'admin', email: 'a@x.test' }, { user_id: 22, role: 'member', email: 'v@x.test' }];

describe('planMove', () => {
  test('keeps the old workspace members in: owner/admin become project admin, member becomes read-only', () => {
    const plan = planMove({ site, source, target, sourceMembers, targetMemberIds: [] });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.grants.map((g) => [g.email, g.projectRole]), [['admizzedu@gmail.com', 'admin'], ['a@x.test', 'admin'], ['v@x.test', 'member']]);
  });
  test('people who already belong to the target workspace are left alone (they keep the stronger, workspace-wide access)', () => {
    const plan = planMove({ site, source, target, sourceMembers, targetMemberIds: [21] });
    assert.deepEqual(plan.grants.map((g) => g.email), ['admizzedu@gmail.com', 'v@x.test']);
    assert.deepEqual(plan.alreadyInTarget, ['a@x.test']);
  });
  test('refuses a missing project, a missing target, or a no-op move', () => {
    assert.equal(planMove({ site: null, source, target, sourceMembers, targetMemberIds: [] }).ok, false);
    assert.equal(planMove({ site, source, target: null, sourceMembers, targetMemberIds: [] }).ok, false);
    assert.match(planMove({ site: { ...site, workspace_id: 1 }, source: target, target, sourceMembers, targetMemberIds: [] }).problems[0], /already in/);
  });
  test('a project that has no workspace yet moves with nobody to carry over', () => {
    const plan = planMove({ site: { ...site, workspace_id: null }, source: null, target, sourceMembers: [], targetMemberIds: [] });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.grants, []);
  });
  test('the description says what will and will not happen', () => {
    const text = describePlan(planMove({ site, source, target, sourceMembers, targetMemberIds: [] }));
    assert.match(text, /Move project "Admizz Education"/);
    assert.match(text, /admizzedu@gmail.com: owner in the old workspace -> project admin/);
    assert.match(text, /Nothing is deleted/);
  });
});

describe('canRemoveSource', () => {
  const plan = planMove({ site, source, target, sourceMembers, targetMemberIds: [] });

  test('the old workspace may go once the move has left it with no projects', () => {
    assert.deepEqual(canRemoveSource({ plan, remainingSites: 0 }), { ok: true });
  });
  test('it stays while it still holds another project (that project\'s people would go with it)', () => {
    const r = canRemoveSource({ plan, remainingSites: 2 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /still has 2 other projects/);
    assert.match(canRemoveSource({ plan, remainingSites: 1 }).reason, /1 other project\b/);
  });
  test('it is never the target, and there must be an old workspace at all', () => {
    assert.equal(canRemoveSource({ plan: { ...plan, source: target }, remainingSites: 0 }).ok, false);
    assert.equal(canRemoveSource({ plan: { ...plan, source: null }, remainingSites: 0 }).ok, false);
    assert.equal(canRemoveSource({ plan: { ok: false, problems: ['x'] }, remainingSites: 0 }).ok, false);
  });
  test('the dry run says what will happen to the old workspace', () => {
    assert.match(describePlan({ ...plan, removeSource: true }), /removed afterwards, but only if it has no other projects/);
    assert.match(describePlan(plan), /Nothing is deleted/);
  });
});
