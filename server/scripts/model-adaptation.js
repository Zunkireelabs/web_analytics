import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { requireWriteAllowed, announceDatabase } from '../lib/script-guard.js';
import { loadDecisionRows, buildDataset, toJsonl } from '../lib/training-examples.js';
import { readinessFor, evaluateModel, majorityPredictor, liveDecisionPredictor, LIVE_EVAL_DEFAULT_EXAMPLES, LIVE_EVAL_MAX_EXAMPLES, registerModel, recordEvaluation, promoteModel, rollbackModel, rejectModel, listModels } from '../lib/model-adaptation.js';

// Model adaptation readiness. Optional: the platform works without any of this. Nothing here trains a model or calls one.
//
//   node server/scripts/model-adaptation.js --readiness                      # is there enough validated data to even try fine-tuning?
//   node server/scripts/model-adaptation.js --prepare --out DIR [--save]     # write scrubbed train/validation/eval files + manifest
//                                                                           #   (--save also records the manifest row in the database)
//   node server/scripts/model-adaptation.js --baseline                       # score the trivial majority-answer baseline on the eval split
//   node server/scripts/model-adaptation.js --models                         # registry
//   node server/scripts/model-adaptation.js --register --name N --provider P --model-id M --kind base|fine-tuned [--dataset V] --by WHO
//   node server/scripts/model-adaptation.js --record-baseline --id N --by WHO  # store the majority baseline as that model's evaluation
//   node server/scripts/model-adaptation.js --evaluate-model --id N --live [--max 50] --by WHO   # REAL calls (costs money): score that registered
//                                                                           #   model on the eval split with the decision engine's own prompt
//   node server/scripts/model-adaptation.js --promote --id N --by WHO --reason "..."   # gated: must beat the incumbent safely
//   node server/scripts/model-adaptation.js --rollback --by WHO --reason "..."
//   node server/scripts/model-adaptation.js --reject --id N --by WHO --reason "..."
//
// Writes (--save, registry actions) go to whatever DATABASE_URL points at. Never point it at the live database without the
// owner's OK. Dataset files contain scrubbed text only, but treat them as internal.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}

async function dataset() { return buildDataset(await loadDecisionRows()); }

async function main() {
  const f = parseArgs(process.argv.slice(2));
  announceDatabase();
  if (f.register || f['evaluate-model'] || f['record-baseline'] || f.promote || f.rollback || f.reject || (f.prepare && f.save)) requireWriteAllowed(f);
  if (f.readiness || f.baseline || f.prepare) {
    const ds = await dataset();
    if (f.readiness) {
      const r = readinessFor(ds.manifest);
      console.log(JSON.stringify(ds.manifest, null, 2));
      console.log(r.ready ? '\nREADY to try fine-tuning.' : '\nNOT READY:');
      for (const b of r.blockers) console.log(`  - ${b}`);
      console.log(`\n${r.note}`);
      return;
    }
    if (f.prepare) {
      if (!f.out) throw new Error('--out DIR is required');
      const dir = resolve(f.out, `dataset-${ds.version}`);
      mkdirSync(dir, { recursive: true });
      for (const k of ['train', 'validation', 'eval']) writeFileSync(join(dir, `${k}.jsonl`), toJsonl(ds.splits[k]));
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(ds.manifest, null, 2));
      console.log(`Wrote ${ds.manifest.counts.total} example(s) to ${dir}`);
      if (f.save) {
        const { query } = await import('../db.js');
        await query(`INSERT INTO training_datasets (version, schema_version, manifest, created_by) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (version) DO NOTHING`, [ds.version, ds.manifest.schemaVersion, JSON.stringify(ds.manifest), f.by || 'cli']);
        console.log('Manifest recorded.');
      }
      return;
    }
    const ev = await evaluateModel(ds.splits.eval, majorityPredictor(ds.splits.train), { datasetVersion: ds.version });
    console.log(JSON.stringify({ baseline: 'majority-answer', ...ev }, null, 2));
    if (ev.n < 50) console.log('\nThe evaluation set is too small for this to support any decision.');
    return;
  }
  if (f.models) {
    for (const m of await listModels()) console.log(`#${m.id} [${m.status}] ${m.kind} ${m.provider}/${m.model_id} dataset=${m.dataset_version ?? '-'} accuracy=${m.evaluation?.accuracy ?? 'not evaluated'}`);
    return;
  }
  if (f.register) {
    const m = await registerModel({ name: f.name, provider: f.provider, modelId: f['model-id'], kind: f.kind, datasetVersion: f.dataset || null, by: f.by });
    console.log(`Registered #${m.id} as candidate.`);
    return;
  }
  if (f['evaluate-model']) {
    if (!f.live) throw new Error('--evaluate-model makes real, paid model calls: pass --live to confirm');
    const id = Number(f.id);
    const model = (await listModels()).find((m) => m.id === id);
    if (!model) throw new Error(`No model ${id}`);
    const ds = await dataset();
    const max = Math.min(Number(f.max) || LIVE_EVAL_DEFAULT_EXAMPLES, LIVE_EVAL_MAX_EXAMPLES);
    const examples = ds.splits.eval.slice(0, max);
    if (examples.length < 50) console.error(`WARNING: only ${examples.length} evaluation example(s); a model cannot be promoted on fewer than 50.`);
    console.error(`[evaluate-model] ${examples.length} real call(s) to ${model.provider}/${model.model_id}`);
    const ev = await evaluateModel(examples, await liveDecisionPredictor({ model: model.model_id, provider: model.provider }), { datasetVersion: ds.version });
    await recordEvaluation(id, ev, { by: f.by });
    console.log(JSON.stringify(ev, null, 2));
    return;
  }
  if (f['record-baseline']) {
    const ds = await dataset();
    const ev = await evaluateModel(ds.splits.eval, majorityPredictor(ds.splits.train), { datasetVersion: ds.version });
    await recordEvaluation(Number(f.id), ev, { by: f.by });
    console.log(`Recorded evaluation on dataset ${ds.version} (n=${ev.n}, accuracy=${ev.accuracy}).`);
    return;
  }
  if (f.promote) { const m = await promoteModel(Number(f.id), { by: f.by, reason: f.reason }); console.log(`#${m.id} is now active.`); return; }
  if (f.rollback) { console.log(JSON.stringify(await rollbackModel({ by: f.by, reason: f.reason }))); return; }
  if (f.reject) { const m = await rejectModel(Number(f.id), { by: f.by, reason: f.reason }); console.log(`#${m.id} rejected.`); return; }
  console.log('See the usage notes at the top of server/scripts/model-adaptation.js');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pool } = await import('../db.js');
  main().then(() => pool.end()).then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
}
