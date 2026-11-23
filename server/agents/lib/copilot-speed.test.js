import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveAgentRunsInChat, freshnessNote } from './copilot.js';

test('chat never runs agents live unless COPILOT_LIVE_AGENT_RUNS=true', () => {
  assert.equal(liveAgentRunsInChat({}), false);
  // The flag that drives Command Center / Action Center does not turn it on.
  assert.equal(liveAgentRunsInChat({ AGENTIC_ORCHESTRATION_ENABLED: 'true' }), false);
  assert.equal(liveAgentRunsInChat({ COPILOT_LIVE_AGENT_RUNS: 'false' }), false);
  assert.equal(liveAgentRunsInChat({ COPILOT_LIVE_AGENT_RUNS: 'true' }), true);
});

test('freshness note only when the stored analysis is a day or more old', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  assert.equal(freshnessNote(null, now), '');
  assert.equal(freshnessNote('2026-11-23T03:00:00Z', now), '');
  assert.match(freshnessNote('2026-11-22T06:00:00Z', now), /from yesterday/);
  assert.match(freshnessNote('2026-11-20T06:00:00Z', now), /from 3 days ago/);
  assert.equal(freshnessNote('not a date', now), '');
});
