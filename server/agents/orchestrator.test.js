import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// synthesizeFindings calls the real callLLM whenever any agent returns a
// finding — mocked so these tests never make a live API call, same
// discipline as competitor-analysis.test.js.
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'mock narrative' },
});

const { runOrchestration } = await import('./orchestrator.js');

// Real incident, 2026-09-03: runOrchestration's Promise.all over N agents
// means ANY ONE agent that never resolves blocks the whole battery forever —
// saveAgentRun (the executive-report row the hourly catch-up guard checks
// for) never fires, so a fault in one agent silently costs the entire day.
// Two separate detection attempts that morning both got the same 8 fast
// agents done and never finished the 8 slower, real-per-page ones. This
// suite proves the fix directly: a per-agent timeout keeps runOrchestration
// bounded no matter how badly one agent misbehaves, without waiting out the
// real 5-minute default (both `timeoutMs` and `runAgentFn` are test-only
// overrides — see orchestrator.js's own comment on runAgentWithTimeout).
describe('runOrchestration — one hung agent must never block the whole battery', () => {
  test('a never-resolving agent times out; the rest of the battery still completes', async () => {
    const fakeRunAgent = async (id) => {
      if (id === 'hung-agent') return new Promise(() => {}); // never resolves — the exact 2026-09-03 shape
      return { status: 'ok', facts: { findings: [] }, narrative: null };
    };

    const start = Date.now();
    const { ranAgentIds, perAgent } = await runOrchestration({
      siteId: 1, start: '2026-08-27', end: '2026-09-03',
      agentIds: ['fast-agent-1', 'hung-agent', 'fast-agent-2'],
      agentTimeoutMs: 30, // real default is 5 minutes; this proves the mechanism without waiting it out
      runAgentFn: fakeRunAgent,
    });
    const elapsedMs = Date.now() - start;

    assert.deepEqual(ranAgentIds, ['fast-agent-1', 'hung-agent', 'fast-agent-2']);
    assert.equal(perAgent['fast-agent-1'].status, 'ok');
    assert.equal(perAgent['fast-agent-2'].status, 'ok');
    assert.equal(perAgent['hung-agent'].status, 'error');
    assert.match(perAgent['hung-agent'].message, /too long/);
    // The real proof: this awaited to completion at all, well under the real
    // 5-minute default — the old Promise.all-with-no-timeout shape would
    // have hung this test (and the real daily job) forever.
    assert.ok(elapsedMs < 5000, `expected the battery to resolve quickly once the hung agent times out, took ${elapsedMs}ms`);
  });

  test('an agent that throws is reported as an error, same as before this fix', async () => {
    const fakeRunAgent = async (id) => {
      if (id === 'broken-agent') throw new Error('boom');
      return { status: 'ok', facts: { findings: [] }, narrative: null };
    };

    const { perAgent } = await runOrchestration({
      siteId: 1, start: '2026-08-27', end: '2026-09-03',
      agentIds: ['broken-agent'],
      agentTimeoutMs: 30,
      runAgentFn: fakeRunAgent,
    });

    assert.equal(perAgent['broken-agent'].status, 'error');
  });

  test('a normal, fully-healthy run is unaffected by the timeout machinery', async () => {
    const fakeRunAgent = async (id) => ({
      status: 'ok',
      facts: { findings: [{ id: `${id}:1`, priority: 'high', whyItMatters: 'x' }] },
      narrative: null,
    });

    const { findings, perAgent } = await runOrchestration({
      siteId: 1, start: '2026-08-27', end: '2026-09-03',
      agentIds: ['agent-a', 'agent-b'],
      agentTimeoutMs: 30,
      runAgentFn: fakeRunAgent,
    });

    assert.equal(perAgent['agent-a'].status, 'ok');
    assert.equal(perAgent['agent-b'].status, 'ok');
    assert.equal(findings.length, 2);
  });
});
