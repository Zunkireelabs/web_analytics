import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onUnlessDisabled, capabilityReport, capabilityEnabled } from './feature-flags.js';
import { learningEvidenceEnabled } from './learning-evidence.js';
import { industryRankingEnabled } from './industry-intelligence.js';

test('unset means on; only an explicit off value disables', () => {
  for (const v of [undefined, null, '', 'on', 'true', '1', 'yes', 'anything']) assert.equal(onUnlessDisabled(v), true, String(v));
  for (const v of ['off', 'OFF', 'false', '0', 'no', ' disabled ']) assert.equal(onUnlessDisabled(v), false, v);
});

test('the learning capabilities are on in a clean production environment and off only on purpose', () => {
  assert.equal(learningEvidenceEnabled({}), true);
  assert.equal(industryRankingEnabled({}), true);
  assert.equal(capabilityEnabled('MODEL_REGISTRY', {}), true);
  assert.equal(learningEvidenceEnabled({ LEARNING_EVIDENCE_IN_DECISIONS: 'off' }), false);
  assert.equal(industryRankingEnabled({ INDUSTRY_INTELLIGENCE_RANKING: 'false' }), false);
});

test('the report lists every capability with whether it is on and what it does', () => {
  const r = capabilityReport({ MODEL_REGISTRY: 'off' });
  assert.equal(r.length, 3);
  assert.equal(r.find((c) => c.name === 'MODEL_REGISTRY').enabled, false);
  assert.ok(r.every((c) => c.does.length > 10));
});
