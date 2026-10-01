import 'dotenv/config';
import { pool } from '../db.js';

// Reclaims the two tables that dominate storage on the free-plan database
// (measured 2026-10-01: internal_errors 57MB + agent_runs 21MB of ~120MB):
//
//   1. agent_runs.facts — a persisted run's `facts` averages ~26KB, and only the
//      latest run per agent is read for findings (a diff reads the newest 2,
//      the history API up to 10). Older superseded runs keep their ROW (the
//      Review Report COUNTS rows via getAgentRunSummarySince, and the activity
//      feed lists them) but their `facts` blob is set to NULL — a state
//      runner.js already writes for failed runs, so every reader tolerates it.
//      The row a site's baseline report points at (sites.baseline_run_id) is
//      never touched.
//   2. internal_errors — one failing integration wrote 44,121 identical rows.
//      Keep the newest N per (context, message) and drop older excess. (New
//      repeats are already suppressed at the source, lib/errors.js.)
//
// Neither is destructive to anything a user sees: no row a counter or the UI
// lists is deleted from agent_runs, and every distinct error stays represented.
//
//   node server/scripts/prune-bulky-data.js                  (dry run, default — read-only transaction)
//   node server/scripts/prune-bulky-data.js --apply          (actually prune)
//   flags: --keep-runs 5  --run-age-days 14  --error-keep 25  --error-age-days 7
//
// Note: Postgres reuses freed space for new rows but does not hand it back to the
// OS until a VACUUM FULL; Supabase's size meter follows the file, so the number on
// the dashboard drops after that, while growth stops immediately.

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

const mb = (bytes) => `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;

const RUN_CANDIDATES_SQL = `
  WITH ranked AS (
    SELECT id, created_at, facts,
           row_number() OVER (PARTITION BY site_id, agent_id ORDER BY created_at DESC) AS rn
      FROM agent_runs
  )
  SELECT id, pg_column_size(facts) AS bytes
    FROM ranked
   WHERE rn > $1
     AND created_at < now() - make_interval(days => $2)
     AND facts IS NOT NULL
     AND id NOT IN (SELECT baseline_run_id FROM sites WHERE baseline_run_id IS NOT NULL)`;

const ERROR_CANDIDATES_SQL = `
  WITH ranked AS (
    SELECT id, created_at, pg_column_size(t.*) AS bytes,
           row_number() OVER (PARTITION BY context, left(message, 120) ORDER BY created_at DESC) AS rn
      FROM internal_errors t
  )
  SELECT id, bytes FROM ranked
   WHERE rn > $1 AND created_at < now() - make_interval(days => $2)`;

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const apply = !!flags.apply;
  const keepRuns = Number(flags['keep-runs'] ?? 5);
  const runAgeDays = Number(flags['run-age-days'] ?? 14);
  const errorKeep = Number(flags['error-keep'] ?? 25);
  const errorAgeDays = Number(flags['error-age-days'] ?? 7);
  for (const [name, v] of Object.entries({ keepRuns, runAgeDays, errorKeep, errorAgeDays })) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`--${name} must be a non-negative integer`);
  }

  console.log(`Mode: ${apply ? 'APPLY (will modify the database)' : 'DRY RUN (read-only; pass --apply to prune)'}`);
  console.log(`agent_runs: null out facts on runs older than ${runAgeDays}d beyond the newest ${keepRuns} per (site, agent)`);
  console.log(`internal_errors: delete rows older than ${errorAgeDays}d beyond the newest ${errorKeep} per (context, message)\n`);

  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');

    const runs = await client.query(RUN_CANDIDATES_SQL, [keepRuns, runAgeDays]);
    const runBytes = runs.rows.reduce((s, r) => s + Number(r.bytes), 0);
    console.log(`agent_runs.facts   -> ${runs.rows.length} run(s), ${mb(runBytes)} of payload to clear (rows are kept)`);

    const errs = await client.query(ERROR_CANDIDATES_SQL, [errorKeep, errorAgeDays]);
    const errBytes = errs.rows.reduce((s, r) => s + Number(r.bytes), 0);
    console.log(`internal_errors    -> ${errs.rows.length} row(s), ${mb(errBytes)} to delete`);

    if (apply) {
      if (runs.rows.length) {
        await client.query('UPDATE agent_runs SET facts = NULL WHERE id = ANY($1::int[])', [runs.rows.map((r) => r.id)]);
      }
      if (errs.rows.length) {
        await client.query('DELETE FROM internal_errors WHERE id = ANY($1::text[])', [errs.rows.map((r) => r.id)]);
      }
      await client.query('COMMIT');
      console.log('\nApplied.');
    } else {
      await client.query('ROLLBACK');
      console.log('\nNothing changed. Re-run with --apply to prune.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
