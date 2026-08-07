import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateApprovalGate } from './approval-gate.js';

test('all checks passing -> ok, no blocking check', () => {
  const result = evaluateApprovalGate({
    qualityGate: { ok: true, issues: [] },
    renderingConfig: { ok: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.blockingCheck, null);
  assert.equal(result.blockingError, null);
});

test('a failing qualityGate blocks, with issue ids summarized in the error', () => {
  const result = evaluateApprovalGate({
    qualityGate: { ok: false, issues: [{ patternId: 'todo-marker' }, { patternId: 'todo-marker' }, { patternId: 'lorem-ipsum' }] },
    renderingConfig: { ok: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockingCheck, 'qualityGate');
  assert.match(result.blockingError, /todo-marker/);
  assert.match(result.blockingError, /lorem-ipsum/);
  assert.match(result.blockingError, /3 unresolved issue/);
});

test('a failing renderingConfig blocks, using its own error message', () => {
  const result = evaluateApprovalGate({
    qualityGate: { ok: true, issues: [] },
    renderingConfig: { ok: false, reason: 'render-unsafe-target', error: 'raw Markdown would ship to the browser' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockingCheck, 'renderingConfig');
  assert.equal(result.blockingError, 'raw Markdown would ship to the browser');
});

test('a null/absent check (not wired up, e.g. no repo configured) is never treated as failing', () => {
  const result = evaluateApprovalGate({
    qualityGate: { ok: true, issues: [] },
    renderingConfig: null,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.checks), ['qualityGate']);
});

test('the first failing check in insertion order is reported as blocking', () => {
  const result = evaluateApprovalGate({
    qualityGate: { ok: false, issues: [{ patternId: 'todo-marker' }] },
    renderingConfig: { ok: false, error: 'unsafe target' },
  });
  assert.equal(result.blockingCheck, 'qualityGate');
});
