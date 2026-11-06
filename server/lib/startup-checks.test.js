import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStartup, findMissingSchema, REQUIRED_SCHEMA, runStartupChecks } from './startup-checks.js';

const GOOD = { ANTHROPIC_API_KEY: 'sk-ant-real', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_B64: 'abc', SESSION_SECRET: 'long-random-secret' };
const status = (r, cap) => r.findings.find((f) => f.capability === cap);

test('a complete configuration is fully operational', () => {
  const r = evaluateStartup({ env: GOOD });
  assert.equal(r.fullyOperational, true);
  assert.deepEqual(r.blocked, []);
});

test('a missing AI key, GitHub App or session secret is BLOCKED with a recovery step, never silent', () => {
  const r = evaluateStartup({ env: {} });
  for (const cap of ['ai-decisions', 'pull-requests', 'admin-auth']) {
    assert.equal(status(r, cap).status, 'blocked', cap);
    assert.ok(status(r, cap).recovery.length > 10, `${cap} has no recovery path`);
  }
  assert.equal(r.fullyOperational, false);
});

test('a placeholder key counts as missing', () => {
  assert.equal(status(evaluateStartup({ env: { ...GOOD, ANTHROPIC_API_KEY: 'sk-xxxx-placeholder' } }), 'ai-decisions').status, 'blocked');
});

test('explicitly switching a learning capability off is reported as degraded, with how to restore it', () => {
  const r = evaluateStartup({ env: { ...GOOD, LEARNING_EVIDENCE_IN_DECISIONS: 'off' } });
  const f = status(r, 'LEARNING_EVIDENCE_IN_DECISIONS');
  assert.equal(f.status, 'degraded');
  assert.match(f.recovery, /Remove LEARNING_EVIDENCE_IN_DECISIONS/);
  assert.equal(r.fullyOperational, false);
});

test('the design gate is ok when unset or enforce, and degraded when someone sets it to log or off', () => {
  assert.equal(status(evaluateStartup({ env: GOOD }), 'design-gate').status, 'ok');
  assert.equal(status(evaluateStartup({ env: { ...GOOD, DESIGN_GATE_MODE: 'enforce' } }), 'design-gate').status, 'ok');
  assert.equal(status(evaluateStartup({ env: { ...GOOD, DESIGN_GATE_MODE: 'off' } }), 'design-gate').status, 'degraded');
  assert.equal(status(evaluateStartup({ env: { ...GOOD, DESIGN_GATE_MODE: 'log' } }), 'design-gate').status, 'degraded');
});

test('a missing migration is BLOCKED and names the table, migration and what it feeds', () => {
  const r = evaluateStartup({ env: GOOD, schemaMissing: [REQUIRED_SCHEMA[0], REQUIRED_SCHEMA[6]] });
  const f = status(r, 'learning-schema');
  assert.equal(f.status, 'blocked');
  assert.match(f.detail, /sites\.growth_started_at \(migration 230/);
  assert.match(f.detail, /model_registry \(migration 229/);
  assert.match(f.recovery, /migrations\/run\.js/);
});

test('an unverifiable schema is reported, not assumed fine', () => {
  assert.equal(status(evaluateStartup({ env: GOOD, schemaCheckFailed: 'connection refused' }), 'learning-schema').status, 'degraded');
});

test('findMissingSchema compares against what the database really has', async () => {
  const have = REQUIRED_SCHEMA.filter((r) => r.table !== 'model_registry').map((r) => ({ table_name: r.table, column_name: r.column || 'id' }));
  const missing = await findMissingSchema({ query: async () => ({ rows: have }) });
  assert.deepEqual(missing.map((m) => m.table), ['model_registry']);
});

test('runStartupChecks logs every problem and the summary, and never throws', async () => {
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const r = await runStartupChecks({ env: {}, query: async () => { throw new Error('no db'); }, log });
  assert.equal(r.fullyOperational, false);
  assert.ok(lines.some((l) => /BLOCKED ai-decisions/.test(l) && /FIX:/.test(l)));
  assert.ok(lines.some((l) => /blocked/.test(l) && /degraded/.test(l)));
});
