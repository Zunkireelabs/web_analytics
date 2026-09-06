import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeclines, MIN_BASELINE_IMPRESSIONS } from './decline-detection.js';

// Pure over two metric maps — no database, no GSC. The maps are the exact
// shape growth-scoring.js's buildPageMetrics returns.
const m = (entries) => new Map(entries.map(([page, v]) => [page, {
  impressions: 0, clicks: 0, ctr: 0, avgPosition: null, ...v,
}]));

describe('detectDeclines', () => {
  test('flags a page whose impressions fell well below its own baseline', () => {
    const prior = m([['/a', { impressions: 2000, clicks: 100, ctr: 0.05 }]]);
    const current = m([['/a', { impressions: 400, clicks: 20, ctr: 0.05 }]]);

    const { declines } = detectDeclines(current, prior);
    const d = declines.get('/a');
    assert.ok(d, 'a 2000 -> 400 collapse must be detected');
    assert.equal(d.impressionsLost, 1600);
    assert.match(d.reasons.join(' '), /impressions 2000 -> 400/);
  });

  test('ignores a low-volume page so 5 -> 2 impressions is not an emergency', () => {
    const prior = m([['/tiny', { impressions: MIN_BASELINE_IMPRESSIONS - 1, clicks: 1, ctr: 0.2 }]]);
    const current = m([['/tiny', { impressions: 2, clicks: 0, ctr: 0 }]]);

    const { declines } = detectDeclines(current, prior);
    assert.equal(declines.size, 0, 'below the volume floor there is no signal, only noise');
  });

  test('a page that vanished entirely is the most severe decline, not a skipped row', () => {
    const prior = m([['/gone', { impressions: 900, clicks: 50, ctr: 0.055 }]]);
    const { declines } = detectDeclines(m([]), prior);
    assert.ok(declines.get('/gone'), 'absence must not read as "no data, skip"');
  });

  // The signal that makes this preventive rather than a damage report:
  // rankings slip BEFORE impressions do.
  test('flags position erosion even while impressions still look healthy', () => {
    const prior = m([['/slipping', { impressions: 1000, clicks: 50, ctr: 0.05, avgPosition: 4.0 }]]);
    const current = m([['/slipping', { impressions: 1000, clicks: 50, ctr: 0.05, avgPosition: 7.0 }]]);

    const { declines } = detectDeclines(current, prior);
    const d = declines.get('/slipping');
    assert.ok(d, 'a 3-place slide is next week’s impression loss');
    assert.equal(d.impressionsLost, 0, 'nothing lost YET — this is exposure, not damage');
    assert.ok(d.impressionsAtRisk > 0);
    assert.match(d.reasons.join(' '), /slipped 3\.0 places/);
  });

  test('flags CTR decay at a held ranking — still shown, no longer chosen', () => {
    const prior = m([['/dull', { impressions: 1000, clicks: 100, ctr: 0.10, avgPosition: 3 }]]);
    const current = m([['/dull', { impressions: 1000, clicks: 40, ctr: 0.04, avgPosition: 3 }]]);

    const { declines } = detectDeclines(current, prior);
    assert.match(declines.get('/dull').reasons.join(' '), /CTR 10\.0% -> 4\.0%/);
  });

  // The guard that stops an algorithm update becoming 80 pointless PRs.
  test('a uniform site-wide fall marks NO individual page', () => {
    const prior = m([
      ['/a', { impressions: 1000, clicks: 50, ctr: 0.05 }],
      ['/b', { impressions: 1000, clicks: 50, ctr: 0.05 }],
      ['/c', { impressions: 1000, clicks: 50, ctr: 0.05 }],
    ]);
    // Every page down 40% — the site moved, no page underperformed it.
    const current = m([
      ['/a', { impressions: 600, clicks: 30, ctr: 0.05 }],
      ['/b', { impressions: 600, clicks: 30, ctr: 0.05 }],
      ['/c', { impressions: 600, clicks: 30, ctr: 0.05 }],
    ]);

    const { declines, siteWide } = detectDeclines(current, prior);
    assert.equal(declines.size, 0, 'no page edit fixes an algorithm update — escalating all three would be wrong');
    assert.equal(siteWide.siteIsDown, true, 'but the site-wide fall is still reported');
  });

  test('during a site-wide fall, a page falling FASTER than the site is still caught', () => {
    const prior = m([
      ['/ok', { impressions: 1000, clicks: 50, ctr: 0.05 }],
      ['/worse', { impressions: 1000, clicks: 50, ctr: 0.05 }],
    ]);
    const current = m([
      ['/ok', { impressions: 800, clicks: 40, ctr: 0.05 }],   // -20%, with the site
      ['/worse', { impressions: 100, clicks: 5, ctr: 0.05 }], // -90%, far worse
    ]);

    const { declines } = detectDeclines(current, prior);
    assert.ok(!declines.has('/ok'), 'moving with the site is not a page-level decline');
    assert.ok(declines.has('/worse'), 'falling faster than the site is');
  });

  test('a growing page is never a decline', () => {
    const prior = m([['/up', { impressions: 500, clicks: 25, ctr: 0.05, avgPosition: 8 }]]);
    const current = m([['/up', { impressions: 1500, clicks: 90, ctr: 0.06, avgPosition: 4 }]]);
    assert.equal(detectDeclines(current, prior).declines.size, 0);
  });
});
