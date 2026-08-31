import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrationStatus, meta } from './executive-report.js';

// Regression coverage for the masked-outage bug. This agent used to return a
// hardcoded `status: 'ok'`, and runOrchestration never throws (orchestrator.js
// catches per agent and records status:'error' in perAgent), so a run in
// which every one of the 16 required sub-agents failed still persisted an
// agent_runs row reading status:'ok' with zero findings. command-center.js
// maps that row's status straight onto analysisStatus ('ok' -> 'complete'),
// and report/executive-doc.js builds the weekly Google Doc from the same
// run — so a total pipeline outage was reported to the client as "ran clean,
// nothing found". This is the top-level meta-agent, so it masked failure
// system-wide.

describe('orchestrationStatus', () => {
  test('every sub-agent errored is an outage, not a clean run', () => {
    const ids = ['a', 'b', 'c'];
    const result = orchestrationStatus({ a: { status: 'error' }, b: { status: 'error' }, c: { status: 'error' } }, ids);
    assert.equal(result.status, 'error');
    assert.deepEqual(result.failedAgentIds, ids);
    assert.match(result.message, /Every specialist agent failed/);
  });

  test('a partial failure downgrades to insufficient-data and names the failed agents', () => {
    const result = orchestrationStatus({ a: { status: 'ok' }, b: { status: 'error' }, c: { status: 'ok' } }, ['a', 'b', 'c']);
    // command-center.js renders 'insufficient-data' as 'partial' — the point
    // is that it must never render as 'complete'.
    assert.equal(result.status, 'insufficient-data');
    assert.deepEqual(result.failedAgentIds, ['b']);
    assert.match(result.message, /\bb\b/);
  });

  test("a sub-agent's own insufficient-data is an honest abstention, not a failure", () => {
    // A brand-new site with no GSC history yet must not show as broken.
    const result = orchestrationStatus({ a: { status: 'ok' }, b: { status: 'insufficient-data' } }, ['a', 'b']);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.failedAgentIds, []);
    assert.equal(result.message, null);
  });

  test('a required agent missing from perAgent entirely counts as failed, never as passing', () => {
    const result = orchestrationStatus({ a: { status: 'ok' } }, ['a', 'b']);
    assert.equal(result.status, 'insufficient-data');
    assert.deepEqual(result.failedAgentIds, ['b']);
  });

  test('an empty/absent perAgent for the real required list is a full outage', () => {
    assert.equal(orchestrationStatus({}, meta.requires).status, 'error');
    assert.equal(orchestrationStatus(null, meta.requires).status, 'error');
  });
});
