import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { activeModelFor, clearModelOverrideCache } from './model-override.js';

beforeEach(clearModelOverrideCache);
const q = (rows) => { const f = async () => { f.calls++; return { rows }; }; f.calls = 0; return f; };

test('with no promoted model the answer is null, so nothing changes', async () => {
  assert.equal(await activeModelFor('decision', { env: {}, query: q([]) }), null);
});
test('a promoted model is returned with its provider', async () => {
  assert.deepEqual(await activeModelFor('decision', { env: {}, query: q([{ provider: 'anthropic', model_id: 'ft:abc' }]) }), { provider: 'anthropic', model: 'ft:abc' });
});
test('it is cached briefly, not queried on every call', async () => {
  const query = q([{ provider: 'anthropic', model_id: 'm' }]);
  await activeModelFor('decision', { env: {}, query, now: 1000 });
  await activeModelFor('decision', { env: {}, query, now: 2000 });
  assert.equal(query.calls, 1);
  await activeModelFor('decision', { env: {}, query, now: 1000 + 61000 });
  assert.equal(query.calls, 2);
});
test('an explicit off, or no role, never looks anything up', async () => {
  const query = q([{ provider: 'a', model_id: 'm' }]);
  assert.equal(await activeModelFor('decision', { env: { MODEL_REGISTRY: 'off' }, query }), null);
  assert.equal(await activeModelFor(undefined, { env: {}, query }), null);
  assert.equal(query.calls, 0);
});
test('a database failure falls back to the default and never throws', async () => {
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await activeModelFor('decision', { env: {}, query: async () => { throw new Error('down'); } }), null); } finally { console.warn = warn; }
});
