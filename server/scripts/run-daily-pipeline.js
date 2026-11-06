// Runs ONE pass of the unified daily pipeline by hand, for measuring real stage durations before anything is scheduled.
//
//   DAILY_PIPELINE_ENABLED=true node server/scripts/run-daily-pipeline.js [--only <siteId>] [--now <ISO time>]
//
// It runs the same code the scheduled pass will, so it does real work: ingest, email, agents, the analyst sync. It therefore
// refuses to run against a shared or remote database unless that is said out loud (PIPELINE_ALLOW_SHARED_DB=yes). It prints
// every project's per-stage result and how long each took.
import 'dotenv/config';
import { runPipelinePass } from '../lib/daily-pipeline/index.js';
import { listStages } from '../store/pipeline-runs.js';

const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
const local = ['localhost', '127.0.0.1', '::1', 'host.docker.internal', ''].includes(host);
if (!local && process.env.PIPELINE_ALLOW_SHARED_DB !== 'yes') {
  console.error(`Refusing to run: DATABASE_URL points at "${host}", not a local database. This does real work. Set PIPELINE_ALLOW_SHARED_DB=yes only if that is intended.`);
  process.exit(2);
}

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const only = arg('--only');
const at = arg('--now');
const startedAt = Date.now();

const job = await import('../job.js');
const deps = only ? { job: { ...job, listConnectedSites: async () => (await job.listConnectedSites()).filter((s) => String(s.id) === String(only)) } } : {};
const out = await runPipelinePass({ now: at ? new Date(at) : new Date(), deps });
console.log(JSON.stringify(out, null, 2));
if (out.runDate) {
  for (const s of out.sites || []) {
    const rows = await listStages(s.siteId, out.runDate);
    console.log(`\nproject ${s.siteId} "${s.name}"`);
    for (const r of rows) {
      const secs = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) : null;
      console.log(`  ${r.stage.padEnd(16)} ${r.status.padEnd(9)} attempts=${r.attempts} ${secs != null ? `${secs}s` : ''} ${r.error ? `(${r.error})` : ''}`);
    }
  }
}
console.log(`\ntotal ${Math.round((Date.now() - startedAt) / 1000)}s`);
process.exit(0);
