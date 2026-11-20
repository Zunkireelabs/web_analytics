import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sidebarGroups, visibleGroups, breadcrumbFor } from './nav.js';

describe('client-first nav', () => {
  test('groups are in client priority order', () => {
    assert.deepEqual(sidebarGroups({}).map((g) => g.id), ['home', 'needs-you', 'workspace', 'performance', 'more']);
  });
  test('Action Center and Content sit right under Overview', () => {
    const g = sidebarGroups({});
    assert.deepEqual(g[1].items.map((i) => i.label), ['Action Center', 'Content']);
  });
  test('Agents is not a Browse link but its page and breadcrumb still work', () => {
    assert.equal(sidebarGroups({}).flatMap((g) => g.items).some((i) => i.to === '/ai-orchestration'), false);
    assert.equal(visibleGroups({}).flatMap((g) => g.items).some((i) => i.to === '/ai-orchestration'), true);
    assert.deepEqual(breadcrumbFor('/ai-orchestration', {}), ['More', 'Agents']);
  });
  test('Demand shows only for product sites', () => {
    const has = (ctx) => sidebarGroups(ctx).flatMap((g) => g.items).some((i) => i.to === '/demand');
    assert.equal(has({ isProduct: false }), false);
    assert.equal(has({ isProduct: true }), true);
  });
  test('every page that was in the menu is still reachable', () => {
    const all = sidebarGroups({ isProduct: true }).flatMap((g) => g.items.map((i) => i.to));
    for (const to of ['/overview', '/workspace', '/insights', '/ai-visibility', '/keywords', '/competitors', '/compare', '/reports', '/action-center', '/content', '/analyst', '/demand']) assert.ok(all.includes(to), to);
  });
});
