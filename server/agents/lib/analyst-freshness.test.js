import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gate } from './analyst-freshness.js';

// gate() is pure and takes the shape checkAnalystFreshness returns — tested
// directly here rather than through the DB reads, which need a live
// Postgres (see checkAnalystFreshness's own store, data-freshness.js).

describe('gate', () => {
  test('fresh inputs: autonomous action allowed, presented as current', () => {
    const g = gate({ verdict: 'fresh', failingCollectors: [] });
    assert.equal(g.allowAutonomous, true);
    assert.equal(g.presentation, 'current');
  });

  test('degraded inputs: still allowed, but flagged degraded', () => {
    const g = gate({ verdict: 'degraded', failingCollectors: [] });
    assert.equal(g.allowAutonomous, true);
    assert.equal(g.presentation, 'degraded');
  });

  test('stale inputs: autonomous action is REFUSED — the twelve-day outage scenario', () => {
    const g = gate({
      verdict: 'stale',
      failingCollectors: [{ collectorId: 'gsc_page_dimension', status: 'error', error: 'ConnectError (no message)' }],
    });
    assert.equal(g.allowAutonomous, false);
    assert.equal(g.presentation, 'stale-do-not-trust');
    assert.match(g.reason, /gsc_page_dimension/);
  });

  test('stale with no named collector still refuses, with a generic reason', () => {
    const g = gate({ verdict: 'stale', failingCollectors: [] });
    assert.equal(g.allowAutonomous, false);
    assert.match(g.reason, /stale/);
  });
});
