import 'dotenv/config';
import { pool } from '../db.js';

// Removes tenant rows that test files wrote into a real database before the
// NODE_TEST_CONTEXT guard in db.js existed (incident 2026-09-03). Those rows
// carry synthetic gsc_property/ga4_property_id values, which means they
// satisfy listConnectedSites() and enter the per-site nightly loop — 43 of
// them had accumulated 475 agent_runs by 2026-09-09.
//
// Deliberately conservative: a row is only a purge candidate if its name
// matches a *.test.js fixture name AND it has no repo configured AND its
// GSC/GA4 identifiers look synthetic AND it has no login. A real tenant fails
// several of those at once. Dry run by default; --apply to commit.

const FIXTURE_NAME = '%.test.js fixture';
const SYNTHETIC_PROPERTY = '^(test-worker-|test-|generator-learning-|design-agent-|execution-jobs-)';

const CANDIDATES = `
  SELECT s.id, s.name, s.gsc_property, s.created_at
    FROM sites s
   WHERE s.name LIKE $1
     AND s.repo_owner IS NULL
     AND s.repo_name IS NULL
     AND s.auto_remediation_enabled = false
     AND (s.gsc_property IS NULL OR s.gsc_property ~ $2)
     AND (s.ga4_property_id IS NULL OR s.ga4_property_id ~ $2)
     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.site_id = s.id)
   ORDER BY s.id
`;

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows } = await pool.query(CANDIDATES, [FIXTURE_NAME, SYNTHETIC_PROPERTY]);

  if (!rows.length) {
    console.log('No test-fixture tenants found. Nothing to do.');
    return;
  }

  const ids = rows.map((r) => r.id);
  const { rows: [counts] } = await pool.query(
    `SELECT (SELECT count(*) FROM agent_runs      WHERE site_id = ANY($1)) AS agent_runs,
            (SELECT count(*) FROM recommendations WHERE site_id = ANY($1)) AS recommendations,
            (SELECT count(*) FROM drafts          WHERE site_id = ANY($1)) AS drafts`,
    [ids],
  );

  console.log(`${rows.length} test-fixture tenant(s):`);
  for (const r of rows) console.log(`  ${r.id}  ${r.name}  ${r.gsc_property}  ${r.created_at.toISOString().slice(0, 10)}`);
  console.log(`Cascading rows: ${counts.agent_runs} agent_runs, ${counts.recommendations} recommendations, ${counts.drafts} drafts.`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to delete.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Most site_id FKs cascade, but three tables don't (checked against
    // information_schema.referential_constraints): recommendations,
    // execution_jobs, layout_suggestions. execution_jobs also references
    // recommendations, so it must go first.
    await client.query('DELETE FROM execution_jobs WHERE site_id = ANY($1)', [ids]);
    await client.query('DELETE FROM recommendations WHERE site_id = ANY($1)', [ids]);
    await client.query('DELETE FROM layout_suggestions WHERE site_id = ANY($1)', [ids]);
    const res = await client.query('DELETE FROM sites WHERE id = ANY($1)', [ids]);
    await client.query('COMMIT');
    console.log(`Deleted ${res.rowCount} tenant(s) and their cascading rows.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());
