import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, assertTrainingSafe, classifyDecision, toExample, splitFor, buildDataset, toJsonl, identifyingTerms } from './training-examples.js';
import { readinessFor, evaluateModel, majorityPredictor, compareEvaluations, promoteModel, rollbackModel, registerModel, resolveModelOverride, MIN_EVAL_EXAMPLES } from './model-adaptation.js';

const row = (o = {}) => ({
  share_industry_learning: true, workspace_id: 1, action: 'fix_metadata', decision_status: 'verified', impact_status: 'measured', verdict: 'impact-positive', confounded: false,
  situation: 'Titles on https://acme-edu.example/courses/ielts are duplicated; contact owner@acme-edu.example', evidence: [{ source: 'agent', summary: 'Acme Education page /courses/ielts has 2 titles, call +977 9812345678' }],
  missing_evidence: [], rationale: 'Fix titles on acme-edu.example', confidence: 0.8, knownTerms: ['Acme Education', 'acme-edu.example', 'acme'], ...o,
});

test('scrubbing removes urls, emails, domains, phones, paths and client terms', () => {
  const t = scrubText(row().situation + ' ' + row().evidence[0].summary + ' ' + row().rationale, row().knownTerms);
  for (const leak of ['acme', 'Acme', 'http', '@', '9812345678', '/courses']) assert.ok(!t.includes(leak), `${leak} survived: ${t}`);
});

test('an unsafe example is refused, not cleaned', () => {
  assert.throws(() => assertTrainingSafe({ input: { situation: 'see https://x.example/a' }, output: {} }), /unsafe/);
  assert.throws(() => assertTrainingSafe({ input: {}, output: {}, siteId: 4 }), /tenant id/);
  assert.throws(() => assertTrainingSafe({ input: { s: 'Acme did well' }, output: {} }, ['Acme']), /client term/);
});

test('an example carries no tenant id and no client identity', () => {
  const ex = toExample(row(), row().knownTerms);
  const text = JSON.stringify(ex);
  for (const leak of ['acme', 'Acme', 'workspace', 'site_id', 'example']) assert.ok(!text.includes(leak), leak);
});

test('only a measured, positive, unconfounded decision from an opted-in project is eligible', () => {
  assert.deepEqual(classifyDecision(row()), { include: true, label: 'good' });
  const why = (o) => classifyDecision(row(o)).reason;
  assert.equal(why({ share_industry_learning: false }), 'project-opted-out');
  assert.equal(why({ decision_status: 'shipped' }), 'no-measured-outcome');
  assert.equal(why({ impact_status: 'insufficient-data' }), 'no-measured-outcome');
  assert.equal(why({ confounded: true }), 'confounded');
  assert.equal(why({ verdict: 'impact-negative' }), 'negative-outcome');
  assert.equal(why({ verdict: 'impact-inconclusive' }), 'inconclusive-outcome');
  assert.equal(why({ action: 'make_coffee' }), 'unknown-action');
  assert.equal(why({ workspace_id: null }), 'no-workspace');
});

test('a workspace always lands in exactly one split, the same one every time', () => {
  for (const w of [1, 2, 3, 77, 9001]) assert.equal(splitFor(w), splitFor(w));
  const rows = [];
  for (let w = 1; w <= 40; w += 1) for (let i = 0; i < 3; i += 1) rows.push(row({ workspace_id: w, situation: `case ${w}-${i}` }));
  const ds = buildDataset(rows);
  const seen = {};
  for (const [split, list] of Object.entries(ds.splits)) for (const e of list) { /* examples carry no workspace, so check by split membership of ids below */ seen[e.id] = split; }
  assert.equal(ds.manifest.counts.total, 120);
  assert.ok(ds.manifest.counts.train > ds.manifest.counts.eval);
  assert.equal(new Set(Object.keys(seen)).size, 120);
});

test('the dataset version is stable for the same data and changes when the data changes', () => {
  const a = buildDataset([row({ situation: 'one' }), row({ situation: 'two', workspace_id: 2 })]);
  const b = buildDataset([row({ situation: 'two', workspace_id: 2 }), row({ situation: 'one' })]);
  const c = buildDataset([row({ situation: 'one' }), row({ situation: 'three', workspace_id: 2 })]);
  assert.equal(a.version, b.version);
  assert.notEqual(a.version, c.version);
});

test('excluded rows are counted by reason and duplicates are not double counted', () => {
  const ds = buildDataset([row(), row(), row({ verdict: 'impact-negative' }), row({ share_industry_learning: false })]);
  assert.equal(ds.manifest.counts.total, 1);
  assert.deepEqual(ds.manifest.excluded, { duplicate: 1, 'negative-outcome': 1, 'project-opted-out': 1 });
  assert.match(toJsonl(ds.splits.train.concat(ds.splits.validation, ds.splits.eval)), /\n$/);
});

test('brand words inside a domain become identifying terms', () => {
  const t = identifyingTerms({ site_name: 'Acme Education', website_domain: 'www.acme-edu.example', gsc_property: 'sc-domain:acme-edu.example' });
  assert.ok(t.includes('acme-edu'));
});

test('readiness lists every blocker and says ready only when all are met', () => {
  const none = readinessFor({ counts: { train: 3, validation: 0, eval: 0 }, workspaces: { train: 1, validation: 0, eval: 0 }, trainActionCounts: { fix_metadata: 3 } });
  assert.equal(none.ready, false);
  assert.ok(none.blockers.length >= 5);
  const ok = readinessFor({ counts: { train: 600, validation: 60, eval: 60 }, workspaces: { train: 8, validation: 2, eval: 2 }, trainActionCounts: { fix_metadata: 300, improve_page: 300 } });
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.ready, true);
});

const ex = (action) => ({ input: { situation: 's' }, output: { action } });
test('evaluation counts invalid outputs separately from wrong ones', async () => {
  const examples = [ex('fix_metadata'), ex('fix_metadata'), ex('improve_page'), ex('improve_page')];
  const answers = ['fix_metadata', 'improve_page', 'not-an-action', null];
  let i = 0;
  const r = await evaluateModel(examples, async () => { const a = answers[i++]; if (a === null) throw new Error('boom'); return { action: a }; }, { datasetVersion: 'v1' });
  assert.equal(r.accuracy, 0.25);
  assert.equal(r.invalidRate, 0.5);
  assert.equal(r.perAction.fix_metadata.accuracy, 0.5);
});

test('the majority baseline always gives the most common training answer', async () => {
  const p = majorityPredictor([ex('a'), ex('fix_metadata'), ex('fix_metadata')]);
  assert.equal((await p({})).action, 'fix_metadata');
});

const evalOf = (o = {}) => ({ datasetVersion: 'v1', n: 100, accuracy: 0.5, invalidRate: 0, perAction: { fix_metadata: { n: 50, accuracy: 0.5 } }, ...o });
test('a candidate must beat the incumbent by the margin, on the same data, without regressing', () => {
  assert.equal(compareEvaluations(evalOf(), evalOf({ accuracy: 0.6 })).pass, true);
  assert.match(compareEvaluations(evalOf(), evalOf({ accuracy: 0.51 })).reasons.join(), /does not beat/);
  assert.match(compareEvaluations(evalOf(), evalOf({ accuracy: 0.6, datasetVersion: 'v2' })).reasons.join(), /same dataset/);
  assert.match(compareEvaluations(evalOf(), evalOf({ accuracy: 0.6, n: MIN_EVAL_EXAMPLES - 1 })).reasons.join(), /too small/);
  assert.match(compareEvaluations(evalOf(), evalOf({ accuracy: 0.6, invalidRate: 0.05 })).reasons.join(), /invalid-output/);
  assert.match(compareEvaluations(evalOf(), evalOf({ accuracy: 0.7, perAction: { fix_metadata: { n: 50, accuracy: 0.2 } } })).reasons.join(), /got worse/);
  assert.equal(compareEvaluations(null, evalOf()).pass, false);
});

// A tiny in-memory registry standing in for the database.
function fakeRegistry() {
  const models = []; const log = [];
  const query = async (sql, p = []) => {
    if (/INSERT INTO model_registry_log/.test(sql)) { log.push(p); return { rows: [] }; }
    if (/INSERT INTO model_registry /.test(sql)) { const m = { id: models.length + 1, role: p[0], name: p[1], provider: p[2], model_id: p[3], kind: p[4], dataset_version: p[5], status: 'candidate', evaluation: null }; models.push(m); return { rows: [m] }; }
    if (/SELECT \* FROM model_registry WHERE id = \$1/.test(sql)) return { rows: models.filter((m) => m.id === p[0]) };
    if (/status = 'active' LIMIT 1/.test(sql) && /SELECT \*/.test(sql)) return { rows: models.filter((m) => m.role === p[0] && m.status === 'active') };
    if (/kind = 'base'/.test(sql)) return { rows: models.filter((m) => m.kind === 'base' && m.evaluation?.datasetVersion === p[1]).slice(-1) };
    if (/SELECT detail FROM model_registry_log/.test(sql)) return { rows: [] };
    if (/SELECT provider, model_id/.test(sql)) return { rows: models.filter((m) => m.status === 'active').map((m) => ({ provider: m.provider, model_id: m.model_id })) };
    return { rows: [] };
  };
  const tx = { query: async (sql, p = []) => {
    if (/UPDATE model_registry SET status = 'retired'/.test(sql)) models.find((m) => m.id === p[0]).status = 'retired';
    if (/UPDATE model_registry SET status = 'active'/.test(sql)) models.find((m) => m.id === p[0]).status = 'active';
    if (/INSERT INTO model_registry_log/.test(sql)) log.push(p);
    return { rows: [] };
  }, release() {} };
  return { models, log, deps: { query, tx } };
}

test('promotion needs a person, a reason, an evaluation and an evaluated incumbent', async () => {
  const r = fakeRegistry();
  const base = await registerModel({ name: 'base', provider: 'anthropic', modelId: 'b', kind: 'base', by: 'me' }, { deps: r.deps });
  const tuned = await registerModel({ name: 'ft', provider: 'anthropic', modelId: 't', kind: 'fine-tuned', datasetVersion: 'v1', by: 'me' }, { deps: r.deps });
  await assert.rejects(promoteModel(tuned.id, { by: '', reason: 'better', deps: r.deps }), /person/);
  await assert.rejects(promoteModel(tuned.id, { by: 'me', reason: 'ok', deps: r.deps }), /few words/);
  await assert.rejects(promoteModel(tuned.id, { by: 'me', reason: 'looks better', deps: r.deps }), /no evaluation/);
  tuned.evaluation = evalOf({ accuracy: 0.8 });
  await assert.rejects(promoteModel(tuned.id, { by: 'me', reason: 'looks better', deps: r.deps }), /no evaluated incumbent/);
  base.evaluation = evalOf({ accuracy: 0.6 });
  const done = await promoteModel(tuned.id, { by: 'me', reason: 'beats baseline on eval', deps: r.deps });
  assert.equal(models(r, tuned.id).status, 'active');
  assert.ok(done);
});
const models = (r, id) => r.models.find((m) => m.id === id);

test('a worse candidate is refused and stays a candidate; the refusal is logged', async () => {
  const r = fakeRegistry();
  const base = await registerModel({ name: 'base', provider: 'a', modelId: 'b', kind: 'base', by: 'me' }, { deps: r.deps });
  const tuned = await registerModel({ name: 'ft', provider: 'a', modelId: 't', kind: 'fine-tuned', datasetVersion: 'v1', by: 'me' }, { deps: r.deps });
  base.evaluation = evalOf({ accuracy: 0.6 }); tuned.evaluation = evalOf({ accuracy: 0.55 });
  await assert.rejects(promoteModel(tuned.id, { by: 'me', reason: 'trying it out', deps: r.deps }), /Promotion refused/);
  assert.equal(models(r, tuned.id).status, 'candidate');
  assert.ok(r.log.some((p) => p[1] === 'rejected'));
});

test('a fine-tuned model must name its dataset, and rollback with nothing active says so', async () => {
  const r = fakeRegistry();
  await assert.rejects(registerModel({ name: 'x', provider: 'a', modelId: 'm', kind: 'fine-tuned', by: 'me' }, { deps: r.deps }), /dataset version/);
  await assert.rejects(rollbackModel({ by: 'me', reason: 'bad outputs', deps: r.deps }), /nothing to roll back/);
});

test('the registry is ignored unless switched on, and never throws', async () => {
  const r = fakeRegistry();
  r.models.push({ id: 1, role: 'decision', status: 'active', provider: 'a', model_id: 'm' });
  assert.equal(await resolveModelOverride('decision', { env: {}, deps: r.deps }), null);
  assert.deepEqual(await resolveModelOverride('decision', { env: { MODEL_REGISTRY: 'on' }, deps: r.deps }), { provider: 'a', model: 'm' });
  assert.equal(await resolveModelOverride('decision', { env: { MODEL_REGISTRY: 'on' }, deps: { query: async () => { throw new Error('db'); } } }), null);
});

test('the live predictor sends the decision engine\'s own prompt to the named model and refuses a mismatched provider', async () => {
  const calls = [];
  const llm = { pickProvider: () => 'anthropic', callLLMForJson: async (system, user, opts) => { calls.push({ system, user, opts }); return { action: 'fix_metadata' }; } };
  const engine = { decisionPromptFor: (s, e) => ({ system: 'SYS', user: `${s}|${e.length}`, validate: () => true }) };
  const predict = await (await import('./model-adaptation.js')).liveDecisionPredictor({ model: 'cand-1', provider: 'anthropic', deps: { llm, engine } });
  const out = await predict({ situation: 'titles repeat', evidence: [{ source: 'a', summary: 'b', ref: 'secret' }] });
  assert.equal(out.action, 'fix_metadata');
  assert.equal(calls[0].opts.model, 'cand-1', 'the model is forced, so the registry override cannot redirect an evaluation');
  assert.equal(calls[0].system, 'SYS');
  await assert.rejects((await import('./model-adaptation.js')).liveDecisionPredictor({ model: 'x', provider: 'openai', deps: { llm, engine } }), /cannot be evaluated here/);
});
