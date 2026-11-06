import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareDesignTokens } from './visual-design-check.js';

const sec = (o = {}) => ({ kind: 'h2:1:light', columns: 1, contentWidth: 760, padTop: 64, padBottom: 64, bg: [255, 255, 255], heading: { family: 'inter', size: 32, weight: 700, color: [17, 24, 39] }, body: { family: 'inter', size: 17, weight: 400, color: [55, 65, 81] }, ...o });
const page = (sections, vps = ['desktop', 'tablet', 'mobile']) => Object.fromEntries(vps.map((v) => [v, { sections, bodyFont: { family: 'inter', size: 16, weight: 400, color: [0, 0, 0] } }]));

describe('compareDesignTokens — harmless variation vs meaningful regression', () => {
  test('same design, different number of repeated sections and small sub-pixel noise -> match', () => {
    assert.equal(compareDesignTokens(page([sec(), sec({ padTop: 66, heading: { family: 'inter', size: 32.5, weight: 700, color: [17, 24, 39] } }), sec()]), page([sec(), sec()])).verdict, 'match');
  });
  test('spacing, typography, colour, width and arrangement changes are each detected', () => {
    const cases = {
      spacing: sec({ padTop: 140 }),
      typography: sec({ heading: { family: 'inter', size: 48, weight: 700, color: [17, 24, 39] } }),
      color: sec({ bg: [255, 0, 170] }),
      layout: sec({ contentWidth: 1200 }),
    };
    for (const [kind, s] of Object.entries(cases)) {
      const r = compareDesignTokens(page([s]), page([sec()]));
      assert.equal(r.verdict, 'regression', kind); assert.ok(r.issues.some((i) => i.kind === kind), kind);
    }
    const rearranged = compareDesignTokens(page([sec({ kind: 'h1:1:dark' }), sec({ kind: 'h2:3:light' }), sec({ kind: 'x:2:accent' })]), page([sec(), sec(), sec()]));
    assert.ok(rearranged.issues.some((i) => i.kind === 'layout'));
  });
  test('a regression on ONE viewport (mobile only) is reported with that viewport', () => {
    const a = page([sec()]); a.mobile = { ...a.mobile, sections: [sec({ padTop: 150 })] };
    const r = compareDesignTokens(a, page([sec()]));
    assert.equal(r.verdict, 'regression'); assert.deepEqual([...new Set(r.issues.map((i) => i.viewport))], ['mobile']);
  });
  test('nothing measured on either side is UNMEASURABLE, never a match', () => {
    assert.equal(compareDesignTokens(page([]), page([sec()])).verdict, 'unmeasurable');
    assert.equal(compareDesignTokens({}, page([sec()])).verdict, 'unmeasurable');
  });
});
