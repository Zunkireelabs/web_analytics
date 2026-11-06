import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validationState, stagesFor, summarizeLifecycle, explainExperience, getExecutionLifecycle, getBehaviourLearning } from './behaviour-learning.js';

// No database here: pure functions, plus the one SQL function with an injected query so what it asks for is checked.

const base = { draft_id: 1, action_type: 'faq', draft_status: 'draft', created_at: '2026-10-01T00:00:00Z', validation_status: null,
  pr_number: null, implemented_at: null, stage_merged_at: null, abandoned_at: null,
  deployment_status: null, deployment_merged_at: null, impact_status: null, impact_verdict: null };

describe('validationState', () => {
  test('passed needs a recorded gate and no failing one; nothing recorded is its own state', () => {
    assert.equal(validationState(null), 'not-recorded');
    assert.equal(validationState({}), 'not-recorded');
    assert.equal(validationState({ checkedAt: '2026-10-29T00:00:00Z' }), 'not-recorded');
    assert.equal(validationState({ qualityGate: { ok: true } }), 'passed');
    assert.equal(validationState({ qualityGate: { ok: true }, renderingConfig: { ok: true } }), 'passed');
    assert.equal(validationState({ qualityGate: { ok: true }, clientBuild: { ok: false } }), 'failed');
  });
});

describe('stagesFor — each stage is its own fact', () => {
  test('a new draft is generated and nothing else', () => {
    const s = stagesFor(base);
    assert.deepEqual([s.generated, s.prOpened, s.merged, s.deployment, s.impact, s.furthest], [true, false, false, null, null, 'generated']);
  });

  test('a PR opened is not merged', () => {
    const s = stagesFor({ ...base, draft_status: 'pr_opened', pr_number: 7 });
    assert.deepEqual([s.prOpened, s.merged, s.furthest], [true, false, 'pr-opened']);
  });

  test('merged is not deployed: a merge with no verification stays at merged', () => {
    const s = stagesFor({ ...base, pr_number: 7, implemented_at: '2026-10-05T00:00:00Z' });
    assert.equal(s.merged, true);
    assert.equal(s.deployment, 'untracked');
    assert.equal(s.furthest, 'merged');
  });

  test('a deployment still pending, or never detected, is not live', () => {
    const merged = { ...base, pr_number: 7, implemented_at: '2026-10-05T00:00:00Z' };
    assert.equal(stagesFor({ ...merged, deployment_status: 'pending' }).furthest, 'merged');
    const nd = stagesFor({ ...merged, deployment_status: 'not-detected' });
    assert.equal(nd.deployment, 'not-detected');
    assert.equal(nd.furthest, 'merged');
  });

  test('only a verified deployment reaches deployed; a pending impact measurement does not reach measured', () => {
    const s = stagesFor({ ...base, pr_number: 7, implemented_at: '2026-10-05T00:00:00Z', deployment_status: 'deployed', impact_status: 'pending' });
    assert.equal(s.deployment, 'verified');
    assert.equal(s.impact, 'pending');
    assert.equal(s.furthest, 'deployed');
  });

  test('measured verdicts are kept apart, and a row from before verdicts existed is legacy, not a win', () => {
    const m = { ...base, pr_number: 7, implemented_at: '2026-10-05T00:00:00Z', deployment_status: 'deployed', impact_status: 'measured' };
    assert.equal(stagesFor({ ...m, impact_verdict: 'impact-positive' }).impact, 'positive');
    assert.equal(stagesFor({ ...m, impact_verdict: 'impact-negative' }).impact, 'negative');
    assert.equal(stagesFor({ ...m, impact_verdict: 'impact-inconclusive' }).impact, 'inconclusive');
    const legacy = stagesFor({ ...m, impact_verdict: null });
    assert.equal(legacy.impact, 'legacy');
    assert.equal(legacy.furthest, 'measured');
  });

  test('insufficient-data and unmeasurable never reach measured', () => {
    const m = { ...base, pr_number: 7, implemented_at: '2026-10-05T00:00:00Z', deployment_status: 'deployed' };
    assert.equal(stagesFor({ ...m, impact_status: 'insufficient-data' }).furthest, 'deployed');
    assert.equal(stagesFor({ ...m, impact_status: 'unmeasurable' }).furthest, 'deployed');
  });

  test('an abandoned draft is flagged whichever column says so', () => {
    assert.equal(stagesFor({ ...base, draft_status: 'abandoned' }).abandoned, true);
    assert.equal(stagesFor({ ...base, abandoned_at: '2026-10-02T00:00:00Z' }).abandoned, true);
    assert.equal(stagesFor(base).abandoned, false);
  });
});

describe('summarizeLifecycle', () => {
  test('counts every stage separately', () => {
    const merged = { ...base, pr_number: 1, implemented_at: '2026-10-05T00:00:00Z' };
    const stages = [
      stagesFor(base),
      stagesFor({ ...base, draft_id: 2, pr_number: 2, validation_status: { qualityGate: { ok: true } } }),
      stagesFor({ ...merged, draft_id: 3, deployment_status: 'pending' }),
      stagesFor({ ...merged, draft_id: 4, deployment_status: 'deployed', impact_status: 'measured', impact_verdict: 'impact-positive' }),
      stagesFor({ ...merged, draft_id: 5 }),
      stagesFor({ ...merged, draft_id: 6, deployment_status: 'deployed', impact_status: 'insufficient-data' }),
      stagesFor({ ...base, draft_id: 7, draft_status: 'abandoned' }),
    ];
    const s = summarizeLifecycle(stages);
    assert.equal(s.total, 7);
    assert.equal(s.validationPassed, 1);
    assert.equal(s.prOpened, 5);
    assert.equal(s.merged, 4);
    assert.equal(s.deploymentVerified, 2);
    assert.equal(s.deploymentPending, 1);
    assert.equal(s.mergedButUntracked, 1);
    assert.deepEqual(s.impact, { positive: 1, negative: 0, inconclusive: 0, legacy: 0, insufficientData: 1, pending: 0, unmeasurable: 0 });
    assert.equal(s.abandoned, 1);
  });
});

describe('getExecutionLifecycle — what it asks the database', () => {
  test('every table in the query is scoped to the requested site, and the limit is clamped', async () => {
    const seen = [];
    const deps = { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; } };
    await getExecutionLifecycle(42, { limit: 5000, deps });
    const { sql, params } = seen[0];
    assert.equal(params[0], 42);
    assert.equal(params[1], 1000, 'limit clamped');
    assert.match(sql, /WHERE d\.site_id = \$1/);
    assert.match(sql, /fi\.site_id = d\.site_id/, 'impact joined only within the site');
    assert.match(sql, /x\.site_id = d\.site_id/, 'deployment joined only within the site');
  });
});

describe('explainExperience', () => {
  const entry = (o = {}) => ({ successes: 0, failures: 0, refused: 0, infra: 0, total: 0, impactPositive: 0, impactNegative: 0, impactNeutral: 0, demote: false, reason: null, ...o });

  test('no history says so and assumes nothing', () => {
    const r = explainExperience('faq', undefined);
    assert.equal(r.technicalEvidence, 'none');
    assert.match(r.text, /no recorded history/);
    assert.match(r.text, /Nothing is assumed/);
  });

  test('a thin sample is labelled insufficient and not summarised as a rate', () => {
    const r = explainExperience('faq', entry({ successes: 2, failures: 0 }));
    assert.equal(r.technicalEvidence, 'insufficient');
    assert.match(r.text, /only 2 scored attempts so far, too few to judge/);
    assert.ok(!/%/.test(r.text));
  });

  test('evidence levels by sample size', () => {
    assert.equal(explainExperience('g', entry({ successes: 3 })).technicalEvidence, 'limited');
    assert.equal(explainExperience('g', entry({ successes: 9, failures: 1 })).technicalEvidence, 'established');
  });

  test('a real record states exact counts', () => {
    const r = explainExperience('faq', entry({ successes: 7, failures: 2 }));
    assert.match(r.text, /7 of 9 recent attempts shipped or merged \(78%\)/);
    assert.deepEqual(r.counts.shipped, 7);
  });

  test('refusals and infrastructure failures are reported as not counted, not hidden', () => {
    const r = explainExperience('faq', entry({ successes: 4, failures: 0, refused: 2, infra: 3 }));
    assert.match(r.text, /5 more not counted for or against it/);
  });

  test('impact is only summarised once there are enough evidence-supported outcomes, and always carries the correlation caveat', () => {
    const few = explainExperience('faq', entry({ successes: 5, impactPositive: 2 }));
    assert.equal(few.impactEvidence, 'insufficient');
    assert.match(few.text, /2 evidence-supported impact measurements, too few to judge/);
    const enough = explainExperience('faq', entry({ successes: 5, impactPositive: 3, impactNegative: 1 }));
    assert.match(enough.text, /of 4 evidence-supported impact measurements, 3 improved clicks beyond the site's own trend and 1 got worse/);
    assert.match(enough.text, /observed correlation over 28-day windows, not proven cause/);
  });

  test('inconclusive measurements are reported, never folded into the win rate', () => {
    const r = explainExperience('faq', entry({ successes: 5, impactNeutral: 4 }));
    assert.match(r.text, /4 impact measurements were inconclusive/);
    assert.equal(r.impactEvidence, 'insufficient');
    assert.equal(r.counts.impactInconclusive, 4);
    assert.match(r.text, /not proven cause/);
  });

  test('inconclusive measurements never inflate the win count, even beside qualified ones', () => {
    const r = explainExperience('faq', entry({ successes: 6, impactPositive: 3, impactNegative: 1, impactNeutral: 5 }));
    assert.match(r.text, /of 4 evidence-supported impact measurements, 3 improved clicks beyond the site's own trend and 1 got worse/);
    assert.match(r.text, /5 impact measurements were inconclusive/);
    assert.equal(r.counts.impactPositive, 3);
    assert.equal(r.counts.impactInconclusive, 5);
  });

  test('no impact data means no correlation caveat is attached to nothing', () => {
    assert.ok(!/correlation/.test(explainExperience('faq', entry({ successes: 5 })).text));
  });

  test('a demoted generator says why it is held', () => {
    const r = explainExperience('schema', entry({ successes: 1, failures: 3, demote: true, reason: '3 of 4 recent attempts failed or were rejected' }));
    assert.equal(r.demoted, true);
    assert.match(r.text, /Held for human review: 3 of 4 recent attempts failed or were rejected\./);
  });

  test('singular wording is correct', () => {
    assert.match(explainExperience('g', entry({ successes: 1 })).text, /only 1 scored attempt so far/);
    assert.match(explainExperience('g', entry({ successes: 5, impactNeutral: 1 })).text, /1 impact measurement was inconclusive/);
  });
});

describe('getBehaviourLearning', () => {
  test('combines the learned map and the lifecycle, sorted, for one site only', async () => {
    const asked = [];
    const learned = new Map([
      ['schema', { successes: 4, failures: 0, refused: 0, infra: 0, total: 4, impactPositive: 0, impactNegative: 0, impactNeutral: 0, demote: false }],
      ['faq', { successes: 5, failures: 1, refused: 0, infra: 0, total: 6, impactPositive: 0, impactNegative: 0, impactNeutral: 0, demote: false }],
    ]);
    const deps = {
      getLearnedConfidenceMap: async (id) => { asked.push(['map', id]); return learned; },
      query: async (sql, params) => { asked.push(['lifecycle', params[0]]); return { rows: [] }; },
    };
    const r = await getBehaviourLearning(9, { deps });
    assert.deepEqual(r.generators.map((g) => g.generatorId), ['faq', 'schema']);
    assert.equal(r.lifecycle.total, 0);
    assert.ok(asked.every(([, id]) => id === 9));
  });
});
