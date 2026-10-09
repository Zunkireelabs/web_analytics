import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from './redirect-add.js';
import { buildRedirectActionFinding, buildDeadOwnUrlsFinding } from '../agents/lib/gsc-url-audit.js';
import { riskTierForGenerator } from '../agents/lib/risk-tiers.js';

test('generate returns a 301 plan and rejects cross-host or unsafe input', async () => {
  const r = await generate({ params: { from: 'https://s.com/old/', to: 'https://www.s.com/new' } });
  assert.deepEqual([r.content.fromPath, r.content.toPath, r.content.status], ['/old', '/new', 301]);
  await assert.rejects(() => generate({ params: { from: 'https://s.com/a', to: 'https://evil.com/a' } }), /same host/);
  await assert.rejects(() => generate({ params: { from: 'https://s.com/a;rm', to: 'https://s.com/c' } }));
  await assert.rejects(() => generate({ params: { from: 'https://s.com/a', to: 'https://s.com/a' } }));
});

test('audit finding for a matched dead URL carries a redirect-add action, never auto-safe', () => {
  const f = buildRedirectActionFinding({
    dead: { url: 'https://s.com/old', impressions: 12, httpStatus: 404 },
    target: { url: 'https://s.com/new', score: 1, basis: 'legacy-prefix' },
  });
  assert.equal(f.recommendedAction.generatorId, 'redirect-add');
  assert.deepEqual(f.recommendedAction.params, { from: 'https://s.com/old', to: 'https://s.com/new' });
  assert.equal(f.priority, 'high');
  assert.equal(f.reportOnly, null);
});

test('unmatched dead URLs stay report-only with no action', () => {
  const f = buildDeadOwnUrlsFinding({ deadUrls: [{ url: 'https://s.com/x', impressions: 1, httpStatus: 404 }], checkedCount: 5 });
  assert.equal(f.recommendedAction, null);
  assert.ok(f.reportOnly);
});

test('redirect-add is not in the auto-apply safe tier', () => {
  assert.equal(riskTierForGenerator('redirect-add'), 'manual');
});
