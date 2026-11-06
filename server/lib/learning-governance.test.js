import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReview, reviewKnowledge, summarizeLearningQuality } from './learning-governance.js';
import { aggregateGroups, assertShareable, canContribute, buildKnowledgeRows } from './industry-intelligence.js';

test('a review needs an id, a valid state, a reviewer and a real reason', () => {
  assert.deepEqual(validateReview({ id: 3, state: 'quarantined', by: 'Yukta', reason: 'looks wrong to me' }), []);
  assert.equal(validateReview({ id: 3, state: 'deleted', by: 'Y', reason: 'because' }).length, 1);
  assert.equal(validateReview({ id: 'x', state: 'rejected', by: '', reason: 'ok' }).length, 3);
  assert.equal(validateReview({ id: 3, state: 'approved', by: 'Y', reason: 'no' }).length, 1);
});

test('an invalid review never reaches the database', async () => {
  let calls = 0;
  await assert.rejects(reviewKnowledge({ id: 1, state: 'approved', by: '', reason: '' }, { deps: { query: async () => { calls++; return { rows: [] }; } } }), /Review refused/);
  assert.equal(calls, 0);
});

test('reviewing an unknown id fails instead of inventing a row', async () => {
  await assert.rejects(reviewKnowledge({ id: 99, state: 'rejected', by: 'Y', reason: 'not supported' }, { deps: { query: async () => ({ rows: [] }) } }), /No shared knowledge/);
});

test('a review updates the row and writes a log entry naming who and why', async () => {
  const sql = [];
  const query = async (text, params) => {
    sql.push({ text, params });
    if (/^\s*SELECT/i.test(text)) return { rows: [{ id: 5, industry: 'education', sub_industry: '', kind: 'generator-outcome', subject: 'faq', status: 'validated', polarity: 'works', confidence: 'medium', evidence: { sites: 3 } }] };
    if (/^\s*UPDATE/i.test(text)) return { rows: [{ id: 5, review_state: 'quarantined' }] };
    return { rows: [] };
  };
  const row = await reviewKnowledge({ id: 5, state: 'quarantined', by: ' Yukta ', reason: ' suspicious spike ' }, { deps: { query } });
  assert.equal(row.review_state, 'quarantined');
  const insert = sql.find((s) => /INSERT INTO industry_knowledge_log/.test(s.text));
  assert.ok(insert.params.includes('Yukta') && insert.params.includes('suspicious spike') && insert.params.includes('quarantined'));
});

test('learning quality: nothing validated is "no evidence", not a 0% reversal rate', () => {
  const q = summarizeLearningQuality([], [{ industry: 'e', sub_industry: '', kind: 'generator-outcome', subject: 'a', status: 'candidate', evidence: {} }]);
  assert.equal(q.everValidated, 0);
  assert.equal(q.reversalRate, null);
});

test('learning quality counts patterns that held up, reversed, and were held back by a person', () => {
  const k = (subject) => ({ industry: 'e', sub_industry: '', kind: 'generator-outcome', subject });
  const log = [{ ...k('a'), to_status: 'validated' }, { ...k('b'), to_status: 'validated' }, { ...k('c'), to_status: 'validated' }, { ...k('b'), from_status: 'validated', to_status: 'contradicted' }];
  const current = [
    { ...k('a'), status: 'validated', evidence: { confounded: 2 } },
    { ...k('b'), status: 'contradicted', evidence: {} },
    { ...k('c'), status: 'retired', evidence: {}, review_state: 'rejected' },
  ];
  const q = summarizeLearningQuality(log, current);
  assert.equal(q.everValidated, 3);
  assert.equal(q.heldUp, 1);
  assert.equal(q.reversed, 2);
  assert.equal(q.reversalRate, 0.67);
  assert.equal(q.heldBack, 1);
  assert.equal(q.setAsideOutcomes, 2);
});

// ── boundaries ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('aggregation keeps counts only: no site id, workspace id or domain survives into the shared groups', () => {
  const rows = [
    { siteId: 4242, workspaceId: 9191, industry: 'education', generatorId: 'faq', positive: 2, negative: 0, inconclusive: 0, confounded: 1, domain: 'secret-client.example' },
    { siteId: 4343, workspaceId: 9292, industry: 'education', generatorId: 'faq', positive: 1, negative: 0, inconclusive: 0 },
  ];
  const text = JSON.stringify(aggregateGroups(rows));
  for (const leak of ['4242', '9191', '4343', '9292', 'secret-client']) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.match(text, /"confounded":1/);
});

test('shared knowledge refuses a tenant identifier smuggled into evidence or the claim', () => {
  const base = { industry: 'education', subIndustry: '', subject: 'faq', claim: 'ok', evidence: { sites: 3 } };
  assert.doesNotThrow(() => assertShareable(base));
  assert.throws(() => assertShareable({ ...base, evidence: { sites: 3, siteId: 12 } }), /not allowed/);
  assert.throws(() => assertShareable({ ...base, claim: 'client acme.com did well' }), /domain/);
});

test('an opted-out project never contributes', () => {
  assert.equal(canContribute({ share_industry_learning: false, industry: 'Education consultancy', industry_confidence: 'high', industry_source: 'human' }).reason, 'opted-out');
});

test('set-aside (confounded) outcomes never become votes', () => {
  const groups = aggregateGroups([1, 2, 3].map((n) => ({ siteId: n, workspaceId: n, industry: 'education', generatorId: 'faq', positive: 0, negative: 0, inconclusive: 0, confounded: 4 })));
  const [row] = buildKnowledgeRows(groups);
  assert.equal(row.status, 'candidate');
  assert.equal(row.evidence.sites, 0);
  assert.equal(row.evidence.confounded, 12);
});
