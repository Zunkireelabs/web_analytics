import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// POST /get-started/email/check (SRANK-47): the email step of /get-started asks this before sending a code, so
// someone who already has a workspace is offered the app's sign-in instead of ten onboarding questions.
// What matters: every state of a project they belong to answers `member: true` and says which state it is, so the
// page can offer the right thing; a disabled account, an address with no account and an account with no workspace
// all answer false and carry on with the trial.

let users; let project; let access;
mock.module(resolve('../store/users.js'), { namedExports: {
  getUserByEmail: async (e) => users[e] || null,
  getUserById: async (id) => Object.values(users).find((u) => u.id === id) || null,
  getUserStatus: async (id) => (Object.values(users).find((u) => u.id === id)?.status ?? 'active'),
  updateUserPassword: async () => {}, createUser: async () => { throw new Error('not exercised'); } } });
mock.module(resolve('../store/access.js'), { namedExports: {
  findMemberProject: async () => project,
  describeAccess: () => access,
  // store/workspaces.js reads this one from the same module, and mocking a module replaces all of it.
  effectiveState: (row) => row?.access_state || null } });

const router = (await import('./login.js')).default;

async function call(path, body) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods.post);
  if (!layer) throw new Error(`route POST ${path} not registered`);
  const req = { method: 'POST', path, query: {}, body, session: {}, ip: '203.0.113.9', get: () => 'test' };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await layer.route.stack[0].handle(req, res, (e) => { if (e) throw e; });
  return res;
}
const check = (email) => call('/get-started/email/check', { email });

beforeEach(() => {
  users = {
    'owner@acme.test': { id: 7, email: 'owner@acme.test', status: 'active' },
    'off@acme.test': { id: 8, email: 'off@acme.test', status: 'disabled' },
  };
  project = { id: 3, name: 'Acme', website_domain: 'acme.test' };
  access = { state: 'client' };
});

describe('POST /get-started/email/check', () => {
  test('a trial that ended within 30 days is still reported, so it can see its overview', async () => {
    access = { state: 'ended', endedAt: new Date(Date.now() - 29 * 864e5).toISOString() };
    const res = await check('owner@acme.test');
    assert.equal(res.body.member, true);
    assert.equal(res.body.state, 'ended');
  });

  test('a trial that ended more than 30 days ago is treated as new', async () => {
    access = { state: 'ended', endedAt: new Date(Date.now() - 31 * 864e5).toISOString() };
    assert.deepEqual((await check('owner@acme.test')).body, { member: false });
  });

  test('an address with a workspace they can sign in to is told so, with the project', async () => {
    const res = await check(' Owner@Acme.test ');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.member, true);
    assert.equal(res.body.state, 'client');
    assert.deepEqual(res.body.project, { name: 'Acme', domain: 'acme.test' });
  });

  test('a live demo counts too', async () => {
    access = { state: 'demo' };
    assert.equal((await check('owner@acme.test')).body.member, true);
  });

  test('a request still waiting, an ended demo and a refused one are reported too, by state', async () => {
    for (const state of ['pending', 'ended', 'rejected']) {
      access = { state };
      const res = await check('owner@acme.test');
      assert.equal(res.body.member, true, `state ${state}`);
      assert.equal(res.body.state, state);
      assert.deepEqual(res.body.project, { name: 'Acme', domain: 'acme.test' });
    }
  });

  test('a live demo passes on the days left, for the text on the page', async () => {
    access = { state: 'demo', daysLeft: 9 };
    assert.equal((await check('owner@acme.test')).body.daysLeft, 9);
  });

  test('no account, a disabled account, and an account with no workspace all answer false', async () => {
    assert.equal((await check('nobody@acme.test')).body.member, false);
    assert.equal((await check('off@acme.test')).body.member, false);
    project = null;
    assert.equal((await check('owner@acme.test')).body.member, false);
  });

  test('a mistyped address is refused before anything is looked up', async () => {
    const res = await check('nope');
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.member, undefined);
  });
});
