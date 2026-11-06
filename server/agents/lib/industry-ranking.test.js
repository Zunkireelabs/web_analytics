import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRecommendation, industryScore, INDUSTRY_SWING } from './growth-scoring.js';
import { buildDailyQueue } from './daily-queue.js';
import { buildIndustryMap, loadIndustryMap } from '../../lib/industry-intelligence.js';
import { classifyRecommendation } from './autonomy-decision.js';

const item = (o = {}) => ({ industry: 'education', subIndustry: '', kind: 'generator-outcome', subject: 'expand-content', polarity: 'works', status: 'validated', confidence: 'medium', evidence: { sites: 4 }, ...o });
const rec = (id, type = 'expand-content', o = {}) => ({ id, recommendation_type: type, finding_ids: [id], params: { page: `/p${id}` }, ...o });
const map = (i) => new Map([[i.subject, i]]);

describe('industryScore', () => {
  test('validated positive pattern lifts, validated negative lowers, bounded by confidence', () => {
    assert.equal(industryScore(rec(1), item(), undefined).score, INDUSTRY_SWING.medium);
    assert.equal(industryScore(rec(1), item({ polarity: 'does-not-work' }), undefined).score, -INDUSTRY_SWING.medium);
    assert.equal(industryScore(rec(1), item({ confidence: 'high' }), undefined).score, INDUSTRY_SWING.high);
  });
  test('never scores anything that is not validated, low confidence, or contradicted - but says it saw it', () => {
    for (const o of [{ status: 'stale' }, { status: 'contradicted', polarity: 'mixed' }, { status: 'candidate' }, { confidence: 'low' }]) {
      const r = industryScore(rec(1), item(o), undefined);
      assert.equal(r.score, 0, JSON.stringify(o));
      assert.equal(r.basis, null);
      assert.equal(r.factors.length, 1);
    }
  });
  test('the project\'s own measured results outrank other projects\'', () => {
    const r = industryScore(rec(1), item(), { impactConfidence: 0.2 });
    assert.equal(r.score, 0);
    assert.match(r.factors[0], /own measured results/);
  });
  test('no industry item: nothing, not even a factor', () => {
    assert.deepEqual(industryScore(rec(1), undefined, undefined), { score: 0, factors: [], basis: null });
  });
  test('the bound is far below a severity tier step, so it cannot cross tiers', () => {
    assert.ok(INDUSTRY_SWING.high < 100);
  });
});

describe('scoreRecommendation with industry knowledge', () => {
  test('score moves by exactly the industry amount and the factor explains it', () => {
    const base = scoreRecommendation(rec(1), {});
    const withI = scoreRecommendation(rec(1), { industryMap: map(item()) });
    assert.equal(withI.score - base.score, INDUSTRY_SWING.medium);
    assert.ok(withI.factors.some((f) => /industry \(education\) positive in 4 projects/.test(f) && /not proven/.test(f)));
    assert.deepEqual(withI.evidenceBasis, ['industry']);
  });
  test('thin evidence is recognised: tier-only work says severity-only', () => {
    assert.deepEqual(scoreRecommendation(rec(1), {}).evidenceBasis, ['severity-only']);
  });
  test('other generators are untouched', () => {
    const a = scoreRecommendation(rec(1, 'fix-title'), {});
    const b = scoreRecommendation(rec(1, 'fix-title'), { industryMap: map(item()) });
    assert.equal(a.score, b.score);
  });
  test('project history is reported as the basis when present, and industry then stays out', () => {
    const learnedMap = new Map([['expand-content', { confidence: 0.9, impactConfidence: 0.8 }]]);
    const r = scoreRecommendation(rec(1), { learnedMap, industryMap: map(item()) });
    assert.ok(r.evidenceBasis.includes('project-history'));
    assert.ok(!r.evidenceBasis.includes('industry'));
  });
});

describe('daily queue', () => {
  test('industry re-orders within a tier, and cannot lift a lower tier over a higher one', () => {
    const candidates = [rec(1, 'expand-content'), rec(2, 'expand-content'), rec(3, 'fix-canonical')];
    const without = buildDailyQueue({ candidates, remaining: 3 });
    const withI = buildDailyQueue({ candidates, remaining: 3, industryMap: map(item({ confidence: 'high' })) });
    assert.equal(withI.queue.length, without.queue.length);
    const tierOf = (q, id) => q.find((x) => x.rec.id === id).tier;
    const rank = (q, id) => q.findIndex((x) => x.rec.id === id);
    // whichever tier fix-canonical is in, it keeps its position relative to expand-content
    assert.equal(rank(without.queue, 3) < rank(without.queue, 1), rank(withI.queue, 3) < rank(withI.queue, 1));
    assert.ok(tierOf(withI.queue, 1) === tierOf(without.queue, 1));
  });
  test('the report keeps the explanation and the evidence basis', () => {
    const { report } = buildDailyQueue({ candidates: [rec(1)], remaining: 1, industryMap: map(item()) });
    assert.deepEqual(report.topSelected[0].evidenceBasis, ['industry']);
    assert.ok(report.topSelected[0].factors.some((f) => /industry/.test(f)));
  });
});

describe('buildIndustryMap / loadIndustryMap', () => {
  const intel = {
    classified: true,
    validated: [item({ subject: 'a' }), item({ subject: 'b', subIndustry: 'study-abroad' }), item({ subject: 'p', kind: 'practice' })],
    contradicted: [item({ subject: 'c', status: 'contradicted', polarity: 'mixed' })],
    stale: [], emerging: [],
  };
  test('learned items only; curated practices are not ranking evidence; unvalidated included so they can be shown', () => {
    const m = buildIndustryMap(intel);
    assert.deepEqual([...m.keys()].sort(), ['a', 'b', 'c']);
  });
  test('the more specific sub-industry item wins over the whole-industry one', () => {
    const m = buildIndustryMap({ ...intel, validated: [item({ subject: 'a', polarity: 'does-not-work' }), item({ subject: 'a', subIndustry: 'study-abroad' })], contradicted: [] });
    assert.equal(m.get('a').polarity, 'works');
  });
  test('an unclassified project yields an empty map', () => {
    assert.equal(buildIndustryMap({ classified: false, validated: [] }).size, 0);
  });
  test('off by default: does not even look', async () => {
    let called = false;
    const m = await loadIndustryMap(1, { deps: { enabled: false, getIndustryIntelligence: async () => { called = true; return intel; } } });
    assert.equal(m.size, 0);
    assert.equal(called, false);
  });
  test('on: loads; a failure leaves ranking unchanged instead of throwing', async () => {
    assert.equal((await loadIndustryMap(1, { deps: { enabled: true, getIndustryIntelligence: async () => intel } })).size, 3);
    assert.equal((await loadIndustryMap(1, { deps: { enabled: true, getIndustryIntelligence: async () => { throw new Error('db down'); } } })).size, 0);
  });
});

describe('autonomy and approval rules are untouched', () => {
  test('classifyRecommendation takes no industry input, so a score can never change what is allowed to run unattended', () => {
    assert.equal(classifyRecommendation.length <= 3, true);
    const src = classifyRecommendation.toString();
    assert.ok(!/industry/i.test(src));
  });
});
