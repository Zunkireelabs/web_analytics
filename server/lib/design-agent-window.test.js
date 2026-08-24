import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isDesignAgentQuietHours, DESIGN_AGENT_QUIET_START_HOUR_UTC, DESIGN_AGENT_QUIET_END_HOUR_UTC } from './design-agent-window.js';

describe('isDesignAgentQuietHours', () => {
  test('defaults to a 21:00-02:00 UTC window', () => {
    assert.equal(DESIGN_AGENT_QUIET_START_HOUR_UTC, 21);
    assert.equal(DESIGN_AGENT_QUIET_END_HOUR_UTC, 2);
  });

  // The exact real failure this guard exists for: job 628 was killed at
  // 2026-08-24 00:30 UTC, right after the 22:00 nightly pipeline and the
  // 00:00 Action Center sync that queues these jobs in the first place.
  test('is quiet at 00:30 UTC, the hour the real OOM kill happened', () => {
    assert.equal(isDesignAgentQuietHours(new Date('2026-08-24T00:30:00Z')), true);
  });

  test('is quiet right at the 21:00 UTC start boundary', () => {
    assert.equal(isDesignAgentQuietHours(new Date('2026-08-24T21:00:00Z')), true);
  });

  test('is quiet just before the 02:00 UTC end boundary, awake at it', () => {
    assert.equal(isDesignAgentQuietHours(new Date('2026-08-24T01:59:00Z')), true);
    assert.equal(isDesignAgentQuietHours(new Date('2026-08-24T02:00:00Z')), false);
  });

  test('is awake mid-morning and mid-afternoon UTC', () => {
    assert.equal(isDesignAgentQuietHours(new Date('2026-08-24T09:00:00Z')), false);
    assert.equal(isDesignAgentQuietHours(new Date('2026-08-24T15:00:00Z')), false);
  });

  test('is awake just before the 21:00 UTC start boundary', () => {
    assert.equal(isDesignAgentQuietHours(new Date('2026-08-24T20:59:00Z')), false);
  });

  test('a matching start/end hour disables the guard entirely (operator override)', () => {
    assert.equal(isDesignAgentQuietHours(new Date('2026-08-24T00:30:00Z'), { start: 5, end: 5 }), false);
  });
});
