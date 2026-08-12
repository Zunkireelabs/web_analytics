import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let user;
let site;
let recItems;

mock.module(resolve('../../store/users.js'), {
  namedExports: { getUserById: async () => user },
});
mock.module(resolve('../../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});
mock.module(resolve('./recommendation-coordinator.js'), {
  namedExports: { getRecommendations: async () => ({ items: recItems }) },
});

const { buildGreeting, systemPromptFor, resolveDisplayName } = await import('./copilot-greeting.js');

function reset() {
  user = { id: 1, email: 'sarah.chen@lifelinknepal.com', role: 'tenant_admin', display_name: null };
  site = { id: 7, name: 'LifeLinkNepal', website_domain: 'lifelinknepal.com' };
  recItems = [];
}

function item(id, { priority = 'medium', blocked = null } = {}) {
  return { id, tag: `Fix ${id}`, generatorId: 'meta-title', params: { page: `/p${id}` }, priority, designBlockedReason: blocked };
}

describe('resolveDisplayName', () => {
  test('prefers an explicit display_name', () => {
    assert.equal(resolveDisplayName({ display_name: 'Yukta', email: 'x.y@z.com' }), 'Yukta');
  });

  test('derives a plausible name from a personal email', () => {
    assert.equal(resolveDisplayName({ email: 'sarah.chen@example.com' }), 'Sarah Chen');
    assert.equal(resolveDisplayName({ email: 'yukta@example.com' }), 'Yukta');
  });

  test('refuses to greet a role address by its mailbox name', () => {
    // "Hi Info.zunkireelabs" is worse than no name at all.
    assert.equal(resolveDisplayName({ email: 'info.zunkireelabs@gmail.com' }), null);
    assert.equal(resolveDisplayName({ email: 'support@example.com' }), null);
    assert.equal(resolveDisplayName({ email: 'noreply@example.com' }), null);
  });

  test('refuses handles that are clearly not names', () => {
    assert.equal(resolveDisplayName({ email: 'user123@example.com' }), null);
    assert.equal(resolveDisplayName({ email: 'a.b.c.d@example.com' }), null);
  });

  test('no user at all is simply nameless, never a crash', () => {
    assert.equal(resolveDisplayName(null), null);
    assert.equal(resolveDisplayName({}), null);
  });
});

describe('buildGreeting — client audience', () => {
  test('names the person and their site, and counts only actionable items', async () => {
    reset();
    recItems = [item(1), item(2), item(3, { blocked: 'template unverified' })];

    const g = await buildGreeting({ siteId: 7, userId: 1 });

    assert.equal(g.audience, 'client');
    assert.match(g.message, /Hi Sarah Chen/);
    assert.match(g.message, /lifelinknepal\.com/);
    assert.match(g.message, /2 things/, 'the design-blocked item must not be counted as actionable');
    assert.equal(g.stats.blocked, 1);
    assert.equal(g.stats.actionable, 2);
  });

  test('never offers a blocked item as a suggested action', async () => {
    reset();
    recItems = [item(1, { blocked: 'template unverified' }), item(2)];
    const g = await buildGreeting({ siteId: 7, userId: 1 });
    assert.equal(g.suggestedActions.length, 1);
    assert.match(g.suggestedActions[0], /Fix 2/);
  });

  test('says so honestly when everything found is blocked', async () => {
    reset();
    recItems = [item(1, { blocked: 'template unverified' })];
    const g = await buildGreeting({ siteId: 7, userId: 1 });
    assert.match(g.message, /waiting on a design check/);
    assert.deepEqual(g.suggestedActions, [], 'nothing actionable means nothing offered');
  });

  test('a clean site is stated plainly, not padded', async () => {
    reset();
    const g = await buildGreeting({ siteId: 7, userId: 1 });
    assert.match(g.message, /nothing needing your attention/);
  });

  test('client-facing copy never leaks internal vocabulary', async () => {
    reset();
    recItems = [item(1), item(2)];
    const g = await buildGreeting({ siteId: 7, userId: 1 });
    for (const jargon of ['generatorId', 'meta-title', 'risk tier', 'draft', 'agent', 'pull request']) {
      assert.ok(!g.message.toLowerCase().includes(jargon.toLowerCase()), `client greeting must not mention "${jargon}"`);
    }
  });
});

describe('buildGreeting — admin audience', () => {
  test('uses operational framing and surfaces the blocked count', async () => {
    reset();
    user = { id: 2, email: 'yukta@zunkireelabs.com', role: 'platform_admin', display_name: 'Yukta' };
    recItems = [item(1), item(2), item(3, { blocked: 'template unverified' })];

    const g = await buildGreeting({ siteId: 7, userId: 2 });

    assert.equal(g.audience, 'admin');
    assert.match(g.message, /Hi Yukta/);
    assert.match(g.message, /2 open recommendations ready to action/);
    assert.match(g.message, /1 blocked pending design verification/);
  });

  test('admin suggested actions carry the generator id a client\'s must not', async () => {
    reset();
    user = { id: 2, email: 'yukta@zunkireelabs.com', role: 'platform_admin', display_name: 'Yukta' };
    recItems = [item(1)];
    const g = await buildGreeting({ siteId: 7, userId: 2 });
    assert.match(g.suggestedActions[0], /meta-title/);
  });
});

describe('systemPromptFor', () => {
  test('the client prompt forbids internal machinery by name', () => {
    const p = systemPromptFor({ isAdmin: false, name: 'Sarah', siteLabel: 'example.com' });
    assert.match(p, /Never mention internal machinery/);
    assert.match(p, /example\.com/);
    assert.match(p, /Sarah/);
  });

  test('the admin prompt explicitly permits that vocabulary', () => {
    const p = systemPromptFor({ isAdmin: true, name: 'Yukta', siteLabel: 'example.com' });
    assert.match(p, /platform administrator/);
    assert.match(p, /risk tiers/);
  });

  test('an unnamed user yields a prompt with no dangling reference', () => {
    const p = systemPromptFor({ isAdmin: false, name: null, siteLabel: 'example.com' });
    assert.ok(!p.includes('You are speaking with .'), 'must not emit an empty name clause');
  });
});
