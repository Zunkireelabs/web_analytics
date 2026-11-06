// Phase 7: readiness, evaluation and a gated model registry. Optional by design: the platform works today with no fine-tuned
// model, and with MODEL_REGISTRY off (the default) or no active registry row nothing here changes which model is used.
//
// What this module guarantees:
//   - fine-tuning is only RECOMMENDED when there is enough data (readinessFor); it never trains anything itself
//   - a model becomes active only if it beats the incumbent on a held-out evaluation AND does not regress on the guardrails
//     (compareEvaluations), and a named person gives a reason (promoteModel)
//   - every registry change is logged, and rollbackModel returns to the model that was active before
//   - resolveModelOverride returns null (use the existing configuration) whenever the registry is off, empty, or errors
//
// What it does NOT do: call a model, start a training job, or edit llm.js. Wiring resolveModelOverride into callLLM is a
// separate, deliberate step.

import { DECISION_ACTIONS } from '../agents/lib/decision-engine.js';

export const MIN_TRAIN_EXAMPLES = 500;
export const MIN_EVAL_EXAMPLES = 50;
export const MIN_VALIDATION_EXAMPLES = 50;
export const MIN_WORKSPACES = 8;
export const MIN_PER_ACTION = 20;       // an action class with fewer training examples cannot be learned or judged
export const MIN_GAIN = 0.03;           // the candidate must beat the incumbent's accuracy by at least this much
export const ACTION_REGRESSION_TOLERANCE = 0.1;
export const MIN_ACTION_EVAL_SAMPLES = 10;

// ── readiness ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Pure. manifest comes from training-examples.buildDataset. ready=false lists every blocker in plain words.
export function readinessFor(manifest) {
  const blockers = [];
  const c = manifest?.counts || { train: 0, validation: 0, eval: 0 };
  const w = manifest?.workspaces || { train: 0, validation: 0, eval: 0 };
  const totalWorkspaces = (w.train || 0) + (w.validation || 0) + (w.eval || 0);
  if (c.train < MIN_TRAIN_EXAMPLES) blockers.push(`needs ${MIN_TRAIN_EXAMPLES} training examples, has ${c.train}`);
  if (c.validation < MIN_VALIDATION_EXAMPLES) blockers.push(`needs ${MIN_VALIDATION_EXAMPLES} validation examples, has ${c.validation}`);
  if (c.eval < MIN_EVAL_EXAMPLES) blockers.push(`needs ${MIN_EVAL_EXAMPLES} evaluation examples, has ${c.eval}`);
  if (totalWorkspaces < MIN_WORKSPACES) blockers.push(`needs examples from ${MIN_WORKSPACES} workspaces, has ${totalWorkspaces}`);
  const counts = manifest?.trainActionCounts || {};
  const present = Object.entries(counts).filter(([, n]) => n > 0);
  if (present.length < 2) blockers.push('needs at least 2 different kinds of action in training, so a model cannot just learn one answer');
  for (const [action, n] of present) if (n < MIN_PER_ACTION) blockers.push(`action "${action}" has ${n} training examples, needs ${MIN_PER_ACTION} or none`);
  return { ready: blockers.length === 0, blockers, note: 'Ready means "enough data to try", not "will improve". Only a held-out evaluation decides that.' };
}

// ── evaluation ───────────────────────────────────────────────────────────────────────────────────────────────────────

// predict: async (input) => { action }. A prediction that throws or names an unknown action counts as INVALID, not as wrong,
// because a model that breaks the output contract is a different (worse) failure.
export async function evaluateModel(examples, predict, { datasetVersion = null } = {}) {
  let correct = 0;
  let invalid = 0;
  const per = {};
  for (const ex of examples) {
    const want = ex.output.action;
    per[want] = per[want] || { n: 0, correct: 0 };
    per[want].n += 1;
    let got = null;
    try { got = (await predict(ex.input))?.action ?? null; } catch { got = null; }
    if (!DECISION_ACTIONS.includes(got)) { invalid += 1; continue; }
    if (got === want) { correct += 1; per[want].correct += 1; }
  }
  const n = examples.length;
  const perAction = {};
  for (const [a, v] of Object.entries(per)) perAction[a] = { n: v.n, accuracy: v.n ? Number((v.correct / v.n).toFixed(3)) : null };
  return {
    datasetVersion,
    n,
    accuracy: n ? Number((correct / n).toFixed(3)) : null,
    invalidRate: n ? Number((invalid / n).toFixed(3)) : null,
    perAction,
  };
}

// The trivial baseline any real model must beat: always answer the most common training action.
export function majorityPredictor(trainExamples) {
  const counts = {};
  for (const e of trainExamples) counts[e.output.action] = (counts[e.output.action] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? 'investigate_further';
  return async () => ({ action: top });
}

// Pure. Is `candidate` safe and better enough to replace `incumbent`? Both evaluations must be on the same dataset version
// and large enough, so the comparison is like for like.
export function compareEvaluations(incumbent, candidate) {
  const reasons = [];
  if (!incumbent || !candidate) return { pass: false, reasons: ['both models need an evaluation'] };
  if (!incumbent.datasetVersion || incumbent.datasetVersion !== candidate.datasetVersion) reasons.push('the two evaluations are not on the same dataset version');
  if ((candidate.n ?? 0) < MIN_EVAL_EXAMPLES || (incumbent.n ?? 0) < MIN_EVAL_EXAMPLES) reasons.push(`the evaluation set is too small (needs ${MIN_EVAL_EXAMPLES})`);
  if (candidate.accuracy == null || incumbent.accuracy == null) reasons.push('accuracy is missing');
  else if (candidate.accuracy < incumbent.accuracy + MIN_GAIN) reasons.push(`accuracy ${candidate.accuracy} does not beat ${incumbent.accuracy} by at least ${MIN_GAIN}`);
  if ((candidate.invalidRate ?? 1) > (incumbent.invalidRate ?? 0)) reasons.push(`invalid-output rate rose from ${incumbent.invalidRate} to ${candidate.invalidRate}`);
  for (const [action, base] of Object.entries(incumbent.perAction || {})) {
    if ((base.n ?? 0) < MIN_ACTION_EVAL_SAMPLES) continue;
    const now = candidate.perAction?.[action];
    if (!now || now.accuracy == null || base.accuracy == null) continue;
    if (now.accuracy < base.accuracy - ACTION_REGRESSION_TOLERANCE) reasons.push(`"${action}" got worse: ${base.accuracy} -> ${now.accuracy}`);
  }
  return { pass: reasons.length === 0, reasons };
}

// A predictor that really calls a model, on the decision engine's own prompt. COSTS MONEY (one call per example), so it is only
// ever built on purpose: the CLI requires --live, caps the number of examples, and refuses a model that belongs to a provider
// the platform is not configured to use. `model` is passed explicitly, so the registry override can never redirect it.
export const LIVE_EVAL_DEFAULT_EXAMPLES = 50;
export const LIVE_EVAL_MAX_EXAMPLES = 200;
export async function liveDecisionPredictor({ model, provider, deps = {} } = {}) {
  if (!model) throw new Error('a model id is required');
  const { pickProvider, callLLMForJson } = deps.llm || (await import('../llm.js'));
  const configured = pickProvider();
  if (provider && provider !== configured) throw new Error(`this model is for provider "${provider}" but the platform is configured for "${configured}", so it cannot be evaluated here`);
  const { decisionPromptFor } = deps.engine || (await import('../agents/lib/decision-engine.js'));
  return async (input) => {
    const evidence = (input.evidence || []).map((e) => ({ source: e.source, summary: e.summary }));
    const { system, user, validate } = decisionPromptFor(input.situation, evidence);
    const parsed = await callLLMForJson(system, user, { model, tier: 'monthly', maxTokens: 900, validate });
    return { action: parsed?.action };
  };
}

// ── registry ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const need = (v, what) => { if (!v || !String(v).trim()) throw new Error(`${what} is required`); return String(v).trim(); };

async function dbq(deps) { return deps.query || (await import('../db.js')).query; }

async function logEvent(q, { modelId, event, from = null, to = null, detail = {}, reason = '', actor = 'system' }) {
  await q(
    `INSERT INTO model_registry_log (model_id, event, from_status, to_status, detail, reason, actor) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [modelId, event, from, to, JSON.stringify(detail), reason, actor]
  );
}

export async function registerModel({ role = 'decision', name, provider, modelId, kind, datasetVersion = null, notes = '', by }, { deps = {} } = {}) {
  if (!['base', 'fine-tuned'].includes(kind)) throw new Error('kind must be base or fine-tuned');
  if (kind === 'fine-tuned' && !datasetVersion) throw new Error('a fine-tuned model must name the dataset version it was trained on');
  const q = await dbq(deps);
  const { rows } = await q(
    `INSERT INTO model_registry (role, name, provider, model_id, kind, dataset_version, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [role, need(name, 'name'), need(provider, 'provider'), need(modelId, 'modelId'), kind, datasetVersion, notes]
  );
  await logEvent(q, { modelId: rows[0].id, event: 'registered', to: 'candidate', actor: need(by, 'a registrant'), detail: { kind, datasetVersion } });
  return rows[0];
}

export async function recordEvaluation(id, evaluation, { by, deps = {} } = {}) {
  if (!evaluation || evaluation.n == null || !evaluation.datasetVersion) throw new Error('an evaluation needs n and datasetVersion');
  const q = await dbq(deps);
  const { rows } = await q(`UPDATE model_registry SET evaluation = $2::jsonb WHERE id = $1 RETURNING *`, [id, JSON.stringify(evaluation)]);
  if (!rows[0]) throw new Error(`No model ${id}`);
  await logEvent(q, { modelId: id, event: 'evaluated', detail: { n: evaluation.n, accuracy: evaluation.accuracy, invalidRate: evaluation.invalidRate, datasetVersion: evaluation.datasetVersion }, actor: need(by, 'an evaluator') });
  return rows[0];
}

// The incumbent is the active model; with none active it is the best-documented registered base model on the same dataset.
async function incumbentFor(q, candidate) {
  const { rows: active } = await q(`SELECT * FROM model_registry WHERE role = $1 AND status = 'active' LIMIT 1`, [candidate.role]);
  if (active[0]) return active[0];
  const { rows } = await q(
    `SELECT * FROM model_registry WHERE role = $1 AND kind = 'base' AND evaluation->>'datasetVersion' = $2 ORDER BY id DESC LIMIT 1`,
    [candidate.role, candidate.evaluation?.datasetVersion ?? null]
  );
  return rows[0] || null;
}

export async function promoteModel(id, { by, reason, deps = {} } = {}) {
  const actor = need(by, 'a person promoting the model');
  const why = need(reason, 'a reason');
  if (why.length < 5) throw new Error('a reason of at least a few words is required');
  const q = await dbq(deps);
  const { rows: c } = await q(`SELECT * FROM model_registry WHERE id = $1`, [id]);
  const cand = c[0];
  if (!cand) throw new Error(`No model ${id}`);
  if (cand.status === 'active') throw new Error('that model is already active');
  if (['rejected', 'retired'].includes(cand.status)) throw new Error(`a ${cand.status} model cannot be promoted`);
  if (!cand.evaluation) throw new Error('the model has no evaluation, so nothing shows it is safe');
  const inc = await incumbentFor(q, cand);
  if (!inc || !inc.evaluation) throw new Error('there is no evaluated incumbent on the same dataset to compare against: evaluate the current model first');
  const verdict = compareEvaluations(inc.evaluation, cand.evaluation);
  if (!verdict.pass) {
    await logEvent(q, { modelId: id, event: 'rejected', from: cand.status, to: 'candidate', detail: { reasons: verdict.reasons, incumbent: inc.id }, reason: why, actor });
    throw new Error(`Promotion refused: ${verdict.reasons.join('; ')}`);
  }
  const tx = deps.tx || (await beginTx());
  try {
    await tx.query('BEGIN');
    if (inc.status === 'active') await tx.query(`UPDATE model_registry SET status = 'retired' WHERE id = $1`, [inc.id]);
    await tx.query(`UPDATE model_registry SET status = 'active', activated_at = now() WHERE id = $1`, [id]);
    await tx.query(
      `INSERT INTO model_registry_log (model_id, event, from_status, to_status, detail, reason, actor) VALUES ($1,'promoted',$2,'active',$3::jsonb,$4,$5)`,
      [id, cand.status, JSON.stringify({ previousId: inc.status === 'active' ? inc.id : null, incumbent: inc.id }), why, actor]
    );
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release?.();
  }
  return (await q(`SELECT * FROM model_registry WHERE id = $1`, [id])).rows[0];
}

async function beginTx() {
  const { pool } = await import('../db.js');
  return pool.connect();
}

// Back to the model that was active before the current one. Refuses when there is nothing to go back to.
export async function rollbackModel({ role = 'decision', by, reason, deps = {} } = {}) {
  const actor = need(by, 'a person rolling back');
  const why = need(reason, 'a reason');
  const q = await dbq(deps);
  const { rows: a } = await q(`SELECT * FROM model_registry WHERE role = $1 AND status = 'active' LIMIT 1`, [role]);
  const active = a[0];
  if (!active) throw new Error('no model is active, so there is nothing to roll back (the platform is already on its default configuration)');
  const { rows: lg } = await q(`SELECT detail FROM model_registry_log WHERE model_id = $1 AND event = 'promoted' ORDER BY id DESC LIMIT 1`, [active.id]);
  const previousId = lg[0]?.detail?.previousId ?? null;
  const tx = deps.tx || (await beginTx());
  try {
    await tx.query('BEGIN');
    await tx.query(`UPDATE model_registry SET status = 'retired' WHERE id = $1`, [active.id]);
    if (previousId) await tx.query(`UPDATE model_registry SET status = 'active', activated_at = now() WHERE id = $1`, [previousId]);
    await tx.query(
      `INSERT INTO model_registry_log (model_id, event, from_status, to_status, detail, reason, actor) VALUES ($1,'rolled-back','active','retired',$2::jsonb,$3,$4)`,
      [active.id, JSON.stringify({ restoredId: previousId }), why, actor]
    );
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release?.();
  }
  return { retiredId: active.id, restoredId: previousId, now: previousId ? 'previous model' : 'platform default configuration' };
}

export async function rejectModel(id, { by, reason, deps = {} } = {}) {
  const actor = need(by, 'a person'); const why = need(reason, 'a reason');
  const q = await dbq(deps);
  const { rows } = await q(`UPDATE model_registry SET status = 'rejected' WHERE id = $1 AND status <> 'active' RETURNING *`, [id]);
  if (!rows[0]) throw new Error('model not found, or it is active (roll back first)');
  await logEvent(q, { modelId: id, event: 'rejected', to: 'rejected', reason: why, actor });
  return rows[0];
}

export async function listModels({ role = 'decision', deps = {} } = {}) {
  const q = await dbq(deps);
  return (await q(`SELECT * FROM model_registry WHERE role = $1 ORDER BY id DESC`, [role])).rows;
}

// Where callLLM could ask "should I use a registered model?". Null means "use the existing configuration", which is the
// answer unless the registry is explicitly on AND a model was deliberately promoted. Never throws.
export async function resolveModelOverride(role = 'decision', { env = process.env, deps = {} } = {}) {
  if (env.MODEL_REGISTRY !== 'on') return null;
  try {
    const q = await dbq(deps);
    const { rows } = await q(`SELECT provider, model_id FROM model_registry WHERE role = $1 AND status = 'active' LIMIT 1`, [role]);
    return rows[0] ? { provider: rows[0].provider, model: rows[0].model_id } : null;
  } catch {
    return null;
  }
}
