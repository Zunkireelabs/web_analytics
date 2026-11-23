import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSiteCtrCurve, INDUSTRY_CTR_CURVE, PRIOR_IMPRESSIONS, SITE_DOMINANT_IMPRESSIONS, trafficGainNote, curveLabel,
} from './site-ctr-curve.js';
import { ctrAtPosition, TRAFFIC_GAIN_NOTE } from './opportunity-scoring.js';
import { demandScore } from './growth-scoring.js';
import { quickWins } from './growth-opportunities.js';

const row = (query, avgPosition, impressions, clicks) => ({ query, avgPosition, impressions, clicks });

describe('buildSiteCtrCurve', () => {
  test('no rows → exactly the industry curve at every position', () => {
    const c = buildSiteCtrCurve([]);
    assert.equal(c.source, 'industry');
    for (const p of [1, 2, 3, 5, 10, 14, 30]) assert.equal(c.at(p), ctrAtPosition(p));
    assert.equal(c.sourceAt(3), 'industry');
  });

  test('plenty of site data → the site\'s own measured CTR dominates', () => {
    // 20,000 impressions at #3 with a 3% CTR (industry says 11%).
    const c = buildSiteCtrCurve([row('a', 3, 20000, 600)]);
    const expected = (600 + PRIOR_IMPRESSIONS * ctrAtPosition(3)) / (20000 + PRIOR_IMPRESSIONS);
    assert.ok(Math.abs(c.at(3) - expected) < 1e-12);
    assert.ok(c.at(3) < 0.04, `site-dominated, got ${c.at(3)}`);
    assert.equal(c.sourceAt(3), 'site');
  });

  test('thin data is shrunk toward the industry value, not taken at face value', () => {
    // 20 impressions, 0 clicks at #2 — a raw 0% CTR would be absurd as a baseline.
    const c = buildSiteCtrCurve([row('a', 2, 20, 0)]);
    assert.ok(c.at(2) > ctrAtPosition(2) * 0.9, `should stay near industry, got ${c.at(2)}`);
    assert.equal(c.sourceAt(2), 'blended');
  });

  test('bucket counts as site only at SITE_DOMINANT_IMPRESSIONS', () => {
    assert.equal(buildSiteCtrCurve([row('a', 4, SITE_DOMINANT_IMPRESSIONS - 1, 10)]).sourceAt(4), 'blended');
    assert.equal(buildSiteCtrCurve([row('a', 4, SITE_DOMINANT_IMPRESSIONS, 10)]).sourceAt(4), 'site');
  });

  test('branded queries are excluded so brand CTR does not inflate the top positions', () => {
    const rows = [row('admizz', 1, 50000, 30000), row('study in uk', 1, 5000, 1000)];
    const withBrand = buildSiteCtrCurve(rows);
    const noBrand = buildSiteCtrCurve(rows, { siteName: 'Admizz Education' });
    assert.ok(withBrand.at(1) > 0.5);
    assert.ok(noBrand.at(1) < 0.25, `brand excluded, got ${noBrand.at(1)}`);
    assert.equal(noBrand.summary.brandedExcluded, 1);
  });

  test('curve never rises with position (a #4 is never expected to out-click #3)', () => {
    // Inverted sample: #3 measured low, #4 measured high.
    const c = buildSiteCtrCurve([row('a', 3, 10000, 100), row('b', 4, 10000, 1500)]);
    assert.ok(c.at(4) <= c.at(3));
    for (let p = 2; p <= 10; p++) assert.ok(c.at(p) <= c.at(p - 1), `pos ${p}`);
    assert.ok(c.at(15) <= c.at(10));
  });

  test('ignores rows without position/impressions and deep rows past the tail', () => {
    const c = buildSiteCtrCurve([row('a', null, 100, 5), row('b', 3, 0, 0), row('c', 45, 99999, 0)]);
    assert.equal(c.source, 'industry');
    assert.equal(c.at(45), ctrAtPosition(45));
  });
});

describe('labels', () => {
  test('industry curve keeps the original note text; site curve says so', () => {
    assert.equal(trafficGainNote(INDUSTRY_CTR_CURVE), TRAFFIC_GAIN_NOTE);
    const site = buildSiteCtrCurve(Array.from({ length: 10 }, (_, i) => row(`q${i}`, i + 1, 5000, 100)));
    assert.equal(site.source, 'site');
    assert.match(trafficGainNote(site), /this site's own measured/);
    assert.match(curveLabel('industry'), /not measured for this site/);
  });
});

describe('callers use the site curve', () => {
  // A low-CTR niche: every position earns ~1/3 of the industry CTR.
  const lowCtrSite = buildSiteCtrCurve(
    Array.from({ length: 10 }, (_, i) => row(`q${i}`, i + 1, 20000, Math.round(20000 * ctrAtPosition(i + 1) / 3))),
  );

  test('quickWins: a page normal for THIS site is not flagged, though the industry curve would flag it', () => {
    const recent = [{ query: 'x', page: '/p', avgPosition: 3, impressions: 1000, clicks: 37, ctr: 0.037 }];
    assert.equal(quickWins(recent).length, 1, 'industry curve: 3.7% vs 11% → flagged');
    assert.equal(quickWins(recent, lowCtrSite).length, 0, 'site curve: 3.7% is normal here → not flagged');
  });

  test('quickWins: reason states which curve the expectation came from', () => {
    const recent = [{ query: 'x', page: '/p', avgPosition: 3, impressions: 1000, clicks: 2, ctr: 0.002 }];
    const [win] = quickWins(recent, lowCtrSite);
    assert.equal(win.expectedCtrSource, 'site');
    assert.match(win.reason, /this site's own CTR/);
  });

  test('demandScore: ctr-gap bonus follows the site curve, default unchanged', () => {
    const metrics = { impressions: 1000, avgPosition: 3, ctr: 0.037 };
    assert.ok(demandScore(metrics).factors.some((f) => f.includes('ctr-gap')));
    assert.ok(!demandScore(metrics, lowCtrSite).factors.some((f) => f.includes('ctr-gap')));
  });
});
