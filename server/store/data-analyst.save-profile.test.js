import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSiteProfile } from './data-analyst.js';

// The SQL behaviour (every existing-source x incoming-source combination) was verified on a real Postgres engine; these tests pin the
// contract that must not regress: what is protected, and that callers' parameters are unchanged.
const capture = async (input) => {
  const calls = [];
  await saveSiteProfile(5, input, { run: async (text, params) => { calls.push({ text, params }); return { rows: [] }; } });
  return calls[0];
};

test('the statement protects a person’s industry, topics and site type, and detected / growth-config industries from weaker writes', async () => {
  const { text } = await capture({ industry: 'x', mainTopics: [], siteType: null });
  assert.match(text, /industry_source = 'human' AND EXCLUDED\.industry_source IS DISTINCT FROM 'human'/);
  assert.match(text, /industry_source IN \('growth-config', 'detected'\)/);
  assert.match(text, /EXCLUDED\.industry_source IS NULL OR EXCLUDED\.industry_source IN \('inferred', 'llm-classified', 'unmapped'\)/);
  // industry, source and confidence use the strong rule; topics and site type use the human rule only (the collector may still add topics)
  assert.equal((text.match(/industry_source IN \('growth-config', 'detected'\)/g) || []).length, 3);
  assert.match(text, /main_topics_json = CASE WHEN \(site_profiles\.industry_source = 'human'/);
  assert.match(text, /site_type = CASE WHEN \(site_profiles\.industry_source = 'human'/);
});

test('parameters keep their order and meaning for every existing caller', async () => {
  const { params } = await capture({ industry: 'Software (SaaS)', mainTopics: ['a'], siteType: 'product', industrySource: 'inferred', industryConfidence: 'low' });
  assert.deepEqual(params, [5, 'Software (SaaS)', '["a"]', 'product', 'inferred', 'low']);
});

test('a caller that passes no source (the old collector) still works and writes a NULL source', async () => {
  const { params } = await capture({ industry: 'x', mainTopics: undefined, siteType: undefined });
  assert.deepEqual(params, [5, 'x', '[]', null, null, null]);
});
