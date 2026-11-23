import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeHealthScore, buildHealthBreakdown, buildActionPlan } from './health-score.js';

const f = (id, priority, agentId, value = 10, page) => ({ id, priority, agentId, expectedImpact: { value }, whyItMatters: `why ${id}`, evidence: page ? { page } : undefined });
const cats = new Map([['sec', { category: 'security' }], ['seo1', { category: 'seo' }], ['gap', { category: 'content' }]]);

describe('buildHealthBreakdown', () => {
  // seo loses 3 + 2 = 5, security 4.5 (weight 1.5 x tier 3), content 0.85: no ties
    const findings = [f('a', 'high', 'sec'), f('b', 'high', 'seo1'), f('c', 'medium', 'seo1', 10), f('d', 'low', 'gap', 1)];

  test('groups the open findings by category, with severity counts, biggest loss first', () => {
    const b = buildHealthBreakdown(findings, new Set(), cats);
    assert.deepEqual(b.map((r) => r.category), ['seo', 'security', 'content']);
    const seo = b.find((r) => r.category === 'seo');
    assert.deepEqual([seo.open, seo.critical, seo.important, seo.minor], [2, 1, 1, 0]);
  });

  test('the shares add up to 1 and match the formula: the category weights are used', () => {
    const b = buildHealthBreakdown(findings, new Set(), cats);
    assert.ok(Math.abs(b.reduce((n, r) => n + r.share, 0) - 1) < 0.02);
    // security's weight is 1.5 and content's 0.85: same tier and impact, security loses more
    const same = buildHealthBreakdown([f('x', 'high', 'sec', 10), f('y', 'high', 'gap', 10)], new Set(), cats);
    assert.deepEqual(same.map((r) => r.category), ['security', 'content']);
    assert.ok(same[0].penalty > same[1].penalty);
  });

  test('the total penalty here is the one the score is made of (before its cap)', () => {
    const b = buildHealthBreakdown(findings, new Set(), cats);
    const total = b.reduce((n, r) => n + r.penalty, 0);
    const { penalty } = computeHealthScore(findings, new Set(), cats); // rounded, and capped at 80; this set is far under the cap
    assert.ok(Math.abs(total - penalty) <= 1, `breakdown ${total} vs score penalty ${penalty}`);
  });

  test('fixed findings and duplicates do not count; an agent with no category is "other"; nothing open is an empty list', () => {
    assert.equal(buildHealthBreakdown([f('a', 'high', 'sec')], new Set(['a']), cats).length, 0);
    assert.equal(buildHealthBreakdown([f('a', 'high', 'mystery')], new Set(), cats)[0].category, 'other');
    const withFix = (x) => ({ ...x, recommendedAction: { generatorId: 'meta-title' } });
    const dup = [withFix(f('a', 'high', 'seo1', 10, '/p')), withFix(f('b', 'medium', 'seo1', 10, '/p'))]; // same page, same fix
    assert.equal(buildHealthBreakdown(dup, new Set(), cats)[0].open, 1, 'same page and problem counted once, at its highest severity');
    assert.deepEqual(buildHealthBreakdown([], new Set(), cats), []);
    assert.deepEqual(buildHealthBreakdown(null), []);
  });
});

describe('buildActionPlan', () => {
  test('three severity phases in order plus an ongoing habit; each lists its biggest items first, capped', () => {
    const findings = [
      f('h-small', 'high', 'seo1', 1), f('h-big', 'high', 'seo1', 90), f('m1', 'medium', 'gap', 50), f('l1', 'low', 'gap', 2),
      ...Array.from({ length: 8 }, (_, i) => f(`m-extra-${i}`, 'medium', 'gap', i)),
    ];
    const plan = buildActionPlan(findings, new Set());
    assert.deepEqual(plan.map((p) => p.key), ['critical', 'important', 'minor', 'ongoing']);
    assert.deepEqual(plan[0].items.map((i) => i.id), ['h-big', 'h-small']);
    assert.equal(plan[1].count, 9); assert.equal(plan[1].items.length, 5, 'only the biggest five are listed, but the count is the whole');
    assert.equal(plan[1].items[0].id, 'm1');
    assert.equal(plan[0].window, 'This week');
  });
  test('fixed items drop out; nothing open gives empty phases, not a crash', () => {
    const plan = buildActionPlan([f('a', 'high', 'sec')], new Set(['a']));
    assert.ok(plan.every((p) => p.count === 0 && p.items.length === 0));
    assert.equal(buildActionPlan([]).length, 4);
  });
  test('carries the page and agent so a card can link to the work', () => {
    const [crit] = buildActionPlan([f('a', 'high', 'sec', 10, '/pricing/')]);
    assert.deepEqual(crit.items[0], { id: 'a', whyItMatters: 'why a', page: '/pricing/', agentId: 'sec' });
  });
});
