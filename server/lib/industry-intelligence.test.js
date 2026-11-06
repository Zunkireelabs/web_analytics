import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIndustry, canContribute, siteVote, aggregateGroups, evaluateGroup, buildKnowledgeRows, claimFor, assertShareable,
  curatedRows, selectForProject, describeItem, getIndustryIntelligence, refreshIndustryKnowledge,
  MIN_SITES, MIN_WORKSPACES, MIN_MEASURED,
} from './industry-intelligence.js';

const vote = (siteId, workspaceId, generatorId, positive, negative = 0, extra = {}) =>
  ({ siteId, workspaceId, industry: 'education', subIndustry: '', generatorId, positive, negative, inconclusive: 0, ...extra });

describe('classifyIndustry', () => {
  test('maps free text onto the catalog and prefers a specific industry over horizontal technology', () => {
    assert.deepEqual(classifyIndustry('Education consultancy'), { industry: 'education', subIndustry: '' });
    assert.equal(classifyIndustry('EdTech software platform').industry, 'education');
    assert.equal(classifyIndustry('dental clinic').industry, 'healthcare');
    assert.equal(classifyIndustry('SaaS').industry, 'technology');
  });
  test('sub-industry only when the text clearly says so', () => {
    assert.equal(classifyIndustry('study abroad education consultancy').subIndustry, 'study-abroad');
    assert.equal(classifyIndustry('education').subIndustry, '');
    assert.equal(classifyIndustry('health services', ['dentist']).subIndustry, 'dental');
  });
  test('unplaceable or empty industry is null, never a guess', () => {
    assert.equal(classifyIndustry('B2B logistics for cold chain').industry, null);
    assert.equal(classifyIndustry('').industry, null);
    assert.equal(classifyIndustry(null).industry, null);
  });
});

describe('canContribute', () => {
  const ok = { industry: 'education', industry_source: 'human', industry_confidence: 'high', share_industry_learning: true };
  test('a trusted, opted-in project contributes', () => assert.equal(canContribute(ok).ok, true));
  test('opted-out, unmapped, low-confidence, missing: all refused with a reason', () => {
    assert.equal(canContribute({ ...ok, share_industry_learning: false }).reason, 'opted-out');
    assert.equal(canContribute({ ...ok, industry_source: 'unmapped' }).reason, 'industry-unmapped');
    assert.equal(canContribute({ ...ok, industry_confidence: 'low' }).reason, 'industry-low-confidence');
    assert.equal(canContribute({ ...ok, industry_confidence: null }).reason, 'industry-low-confidence');
    assert.equal(canContribute({ ...ok, industry: '' }).reason, 'no-industry');
    assert.equal(canContribute(null).reason, 'no-profile');
  });
});

describe('votes and promotion', () => {
  test('one project is one vote however many pages it measured', () => {
    assert.equal(siteVote({ positive: 40, negative: 1 }), 'positive');
    assert.equal(siteVote({ positive: 1, negative: 1 }), 'mixed');
    assert.equal(siteVote({ positive: 0, negative: 0 }), null);
  });

  test('inconclusive results are not votes', () => {
    const [g] = aggregateGroups([vote(1, 10, 'faq', 0, 0, { inconclusive: 9 })]);
    assert.equal(g.evidence.sites, 0);
    assert.equal(evaluateGroup(g.evidence).status, 'candidate');
  });

  test('validated only with enough distinct projects AND measured outcomes', () => {
    const three = [vote(1, 10, 'faq', 2), vote(2, 11, 'faq', 2), vote(3, 12, 'faq', 2)];
    const [g] = aggregateGroups(three);
    assert.equal(g.evidence.sites, MIN_SITES);
    assert.equal(g.evidence.workspaces, 3, 'still recorded');
    assert.ok(g.evidence.measured >= MIN_MEASURED);
    const v = evaluateGroup(g.evidence);
    assert.equal(v.status, 'validated');
    assert.equal(v.polarity, 'works');
    assert.equal(v.confidence, 'medium');
  });

  test('a project is its own client: three projects in ONE workspace can validate a pattern', () => {
    const [g] = aggregateGroups([vote(1, 10, 'faq', 3), vote(2, 10, 'faq', 3), vote(3, 10, 'faq', 3)]);
    assert.equal(g.evidence.sites, 3);
    assert.equal(g.evidence.workspaces, 1, 'the workspace is still recorded, only no longer required');
    assert.equal(evaluateGroup(g.evidence).status, 'validated');
  });

  test('two projects, even in different workspaces, are still not enough', () => {
    const [g] = aggregateGroups([vote(1, 10, 'faq', 3), vote(2, 11, 'faq', 3)]);
    assert.equal(evaluateGroup(g.evidence).status, 'candidate');
  });

  test('too few measured outcomes stays a candidate even with enough projects', () => {
    const [g] = aggregateGroups([vote(1, 10, 'faq', 1), vote(2, 11, 'faq', 1), vote(3, 12, 'faq', 1)]);
    assert.equal(g.evidence.measured, 3);
    assert.equal(evaluateGroup(g.evidence).status, 'candidate');
  });

  test('consistent failure becomes a validated "does not work"', () => {
    const [g] = aggregateGroups([vote(1, 10, 'x', 0, 2), vote(2, 11, 'x', 0, 2), vote(3, 12, 'x', 0, 2)]);
    const v = evaluateGroup(g.evidence);
    assert.equal(v.status, 'validated');
    assert.equal(v.polarity, 'does-not-work');
  });

  test('projects that disagree are contradicted, not averaged into a lesson', () => {
    const [g] = aggregateGroups([vote(1, 10, 'x', 3), vote(2, 11, 'x', 3), vote(3, 12, 'x', 0, 3), vote(4, 13, 'x', 0, 3)]);
    assert.equal(evaluateGroup(g.evidence).status, 'contradicted');
  });

  test('established evidence raises confidence to high', () => {
    const rows = Array.from({ length: 8 }, (_, i) => vote(i + 1, 100 + i, 'faq', 2));
    assert.equal(evaluateGroup(aggregateGroups(rows)[0].evidence).confidence, 'high');
  });

  test('a sub-industry group counts only projects in that sub-industry; the industry group counts all', () => {
    const rows = [
      vote(1, 10, 'faq', 2, 0, { subIndustry: 'study-abroad' }),
      vote(2, 11, 'faq', 2, 0, { subIndustry: 'study-abroad' }),
      vote(3, 12, 'faq', 2),
    ];
    const groups = aggregateGroups(rows);
    assert.equal(groups.find((g) => g.subIndustry === '').evidence.sites, 3);
    assert.equal(groups.find((g) => g.subIndustry === 'study-abroad').evidence.sites, 2);
  });

  test('the same project cannot vote twice for one group', () => {
    const [g] = aggregateGroups([vote(1, 10, 'faq', 2), vote(1, 10, 'faq', 2)]);
    assert.equal(g.evidence.sites, 1);
  });

  test('industries stay separate', () => {
    const groups = aggregateGroups([vote(1, 10, 'faq', 2), vote(2, 11, 'faq', 2, 0, { industry: 'healthcare' })]);
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.evidence.sites === 1));
  });
});

describe('privacy', () => {
  test('stored rows contain no project identifiers or planted tenant strings', () => {
    const rows = [
      vote(901, 7001, 'faq', 2, 0, { domain: 'secret-client.example.com', pageUrl: 'https://secret-client.example.com/private', name: 'Acme Confidential' }),
      vote(902, 7002, 'faq', 2),
      vote(903, 7003, 'faq', 2),
    ];
    const built = buildKnowledgeRows(aggregateGroups(rows));
    const blob = JSON.stringify(built);
    for (const s of ['secret-client', 'example.com', 'Acme', 'Confidential', '901', '902', '903', '7001', '7002', '7003']) {
      assert.ok(!blob.includes(s), `leaked "${s}"`);
    }
  });

  test('assertShareable refuses urls, odd subjects, non-catalog industries and unknown evidence keys', () => {
    const base = { industry: 'education', subIndustry: '', subject: 'faq', claim: 'fine', evidence: { sites: 3 } };
    assert.doesNotThrow(() => assertShareable(base));
    assert.throws(() => assertShareable({ ...base, claim: 'see https://client.example.com/page' }), /unshareable/);
    assert.throws(() => assertShareable({ ...base, claim: 'visit client.com' }), /unshareable/);
    assert.throws(() => assertShareable({ ...base, subject: 'Acme Corp page' }), /unshareable/);
    assert.throws(() => assertShareable({ ...base, industry: 'acme-corp' }), /unshareable/);
    assert.throws(() => assertShareable({ ...base, evidence: { sites: 3, siteIds: [1, 2] } }), /unshareable/);
    assert.throws(() => assertShareable({ ...base, evidence: { sites: 3, siteId: 42 } }), /unshareable/);
  });

  test('a generator id that is not a slug is dropped, not stored', () => {
    assert.equal(aggregateGroups([vote(1, 10, 'Client Name FAQ', 2)]).length, 0);
  });

  test('claims always say association, not cause, and never claim more than the counts', () => {
    const [g] = aggregateGroups([vote(1, 10, 'faq', 2), vote(2, 11, 'faq', 2), vote(3, 12, 'faq', 2)]);
    const c = claimFor({ ...g, polarity: 'works' });
    assert.match(c, /observed association, not proven cause/);
    assert.match(c, /3 of 3 projects/);
  });
});

describe('curated starting points', () => {
  test('are guidance, low confidence, never validated, and say they are unproven', () => {
    const rows = curatedRows();
    assert.ok(rows.length >= 5);
    for (const r of rows) {
      assert.equal(r.status, 'candidate');
      assert.equal(r.confidence, 'low');
      assert.equal(r.source, 'curated');
      assert.match(r.claim, /not yet confirmed/);
    }
  });
  test('every catalog industry has at least one', () => {
    const have = new Set(curatedRows().map((r) => r.industry));
    for (const k of ['technology', 'education', 'healthcare', 'real-estate', 'wellness']) assert.ok(have.has(k), k);
  });
});

describe('retrieval', () => {
  const stored = (o) => ({ sub_industry: '', kind: 'practice', surface: 'general', polarity: 'guidance', confidence: 'low', status: 'candidate', source: 'curated', evidence: {}, last_evaluated_at: '2026-11-01', expires_at: null, ...o });
  const rows = [
    stored({ industry: 'education', subject: 'a', claim: 'edu a' }),
    stored({ industry: 'education', sub_industry: 'study-abroad', subject: 'b', claim: 'edu abroad' }),
    stored({ industry: 'healthcare', subject: 'c', claim: 'health c' }),
    stored({ industry: 'education', subject: 'v', kind: 'generator-outcome', source: 'cross-project', status: 'validated', confidence: 'medium', expires_at: '2027-04-01', claim: 'edu validated' }),
    stored({ industry: 'education', subject: 'old', kind: 'generator-outcome', source: 'cross-project', status: 'validated', expires_at: '2026-01-01', claim: 'edu old' }),
    stored({ industry: 'education', subject: 'gone', status: 'retired', claim: 'retired' }),
    stored({ industry: 'education', subject: 'x', kind: 'generator-outcome', source: 'cross-project', status: 'contradicted', claim: 'edu split' }),
  ];
  const now = new Date('2026-11-04');

  test('an education project gets education knowledge only', () => {
    const r = selectForProject(rows, { industry: 'education', subIndustry: '' }, { now });
    const all = [...r.validated, ...r.startingPoints, ...r.contradicted, ...r.stale, ...r.emerging];
    assert.ok(all.every((i) => i.industry === 'education'));
    assert.ok(!all.some((i) => i.claim === 'health c'));
    assert.ok(!all.some((i) => i.claim === 'retired'));
  });
  test('a healthcare project gets healthcare knowledge only', () => {
    const r = selectForProject(rows, { industry: 'healthcare' }, { now });
    assert.deepEqual(r.startingPoints.map((i) => i.claim), ['health c']);
    assert.equal(r.validated.length, 0);
  });
  test('sub-industry items reach only matching sub-industry projects', () => {
    const plain = selectForProject(rows, { industry: 'education', subIndustry: '' }, { now });
    const abroad = selectForProject(rows, { industry: 'education', subIndustry: 'study-abroad' }, { now });
    assert.ok(!plain.startingPoints.some((i) => i.claim === 'edu abroad'));
    assert.ok(abroad.startingPoints.some((i) => i.claim === 'edu abroad'));
  });
  test('labels never let a candidate or stale item read as validated', () => {
    const r = selectForProject(rows, { industry: 'education' }, { now });
    assert.deepEqual(r.validated.map((i) => i.claim), ['edu validated']);
    assert.deepEqual(r.stale.map((i) => i.claim), ['edu old']);
    assert.deepEqual(r.contradicted.map((i) => i.claim), ['edu split']);
    assert.equal(describeItem(rows[4], { now }).status, 'stale');
  });

  test('getIndustryIntelligence: unclassified project gets nothing, with a reason', async () => {
    const none = await getIndustryIntelligence(1, { deps: { query: async () => ({ rows: [] }) } });
    assert.equal(none.classified, false);
    assert.equal(none.validated.length, 0);
    const odd = await getIndustryIntelligence(1, { deps: { query: async () => ({ rows: [{ industry: 'B2B cold chain logistics' }] }) } });
    assert.equal(odd.classified, false);
    assert.match(odd.reason, /not an industry the platform has knowledge for/);
  });

  test('getIndustryIntelligence queries only the project\'s own industry and its own profile row', async () => {
    const calls = [];
    const query = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM site_profiles/.test(sql)) return { rows: [{ industry: 'Education consultancy', industry_source: 'human', industry_confidence: 'high', main_topics_json: ['study abroad'] }] };
      return { rows: rows.filter((r) => r.industry === params[0]) };
    };
    const out = await getIndustryIntelligence(42, { deps: { query }, now });
    assert.equal(calls[0].params[0], 42);
    assert.equal(calls[1].params[0], 'education');
    assert.equal(out.industry, 'education');
    assert.equal(out.subIndustry, 'study-abroad');
    assert.ok(!JSON.stringify(out).includes('health c'));
  });
});

describe('refreshIndustryKnowledge (fake database)', () => {
  test('skips non-contributing projects, writes only shareable rows, retires rows no longer produced', async () => {
    const writes = [];
    const base = { industry: 'Education', industry_source: 'human', industry_confidence: 'high', share_industry_learning: true, main_topics_json: null, generator_id: 'faq', positive: 2, negative: 0, inconclusive: 0 };
    const rows = [
      { ...base, site_id: 1, workspace_id: 10 }, { ...base, site_id: 2, workspace_id: 11 }, { ...base, site_id: 3, workspace_id: 12 },
      { ...base, site_id: 4, workspace_id: 13, share_industry_learning: false },
      { ...base, site_id: 5, workspace_id: 14, industry_confidence: 'low' },
    ];
    const logs = [];
    const query = async (sql, params) => {
      if (/FROM fix_impact/.test(sql)) return { rows };
      if (/INSERT INTO industry_knowledge_log/.test(sql)) { logs.push({ event: params[5], subject: params[4], to: params[7] }); return { rows: [] }; }
      if (/INSERT INTO industry_knowledge /.test(sql)) { writes.push(params); return { rows: [{ id: 1, review_state: 'auto' }] }; }
      if (/WHERE kind = 'generator-outcome'/.test(sql)) return { rows: [{ id: 99, industry: 'education', sub_industry: '', kind: 'generator-outcome', subject: 'old-generator', status: 'validated', polarity: 'works', confidence: 'medium', review_state: 'auto' }] };
      if (/SELECT id, industry/.test(sql)) return { rows: [] };
      if (/UPDATE industry_knowledge/.test(sql)) { writes.push(['retire', params[0]]); return { rows: [] }; }
      return { rows: [] };
    };
    const out = await refreshIndustryKnowledge({ deps: { query } });
    assert.equal(out.contributing, 3);
    assert.deepEqual(out.skipped, { 'opted-out': 1, 'industry-low-confidence': 1 });
    assert.equal(out.validated, 1);
    assert.equal(out.retired, 1);
    assert.ok(writes.some((w) => w[0] === 'education' && w[3] === 'faq' && w[9] === 'validated'));
    assert.ok(writes.some((w) => w[0] === 'retire' && w[1] === 99));
    assert.ok(!JSON.stringify(writes).includes('"site_id"'));
    // every change is logged, and the log carries no tenant identifier either
    assert.ok(logs.some((l) => l.event === 'created' && l.subject === 'faq' && l.to === 'validated'));
    assert.ok(logs.some((l) => l.event === 'retired' && l.subject === 'old-generator'));
    assert.ok(!JSON.stringify(logs).includes('site'));
  });
});
