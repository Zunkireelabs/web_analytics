import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, getOrCreateSite } from '../db.js';

// Minimal migration runner: applies every *.sql file in this folder in order,
// tracked in schema_migrations so a file already applied is never re-run.
//
// Most individual files ARE idempotent on their own (IF NOT EXISTS, DROP
// CONSTRAINT IF EXISTS + re-add) — but idempotent-per-file is not the same
// as safe-to-replay-the-whole-sequence: a later migration can legitimately
// loosen a CHECK constraint an earlier one first tightened (082 tightens
// keyword_gaps.source, 099 loosens it to add 'user_request'). Real data can
// then exist that satisfies the FINAL schema but violates an EARLIER
// migration's now-stale, stricter constraint — so blindly replaying 001..N
// against a database that already has that data crashes on the earlier
// file, even though the database is already fully migrated. Tracking what's
// already applied avoids ever re-running 082 (or any file) against data a
// later migration already moved past.
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows: appliedRows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.filename));

  const files = readdirSync(here)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(here, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    console.log('ok');
  }

  // Seed the configured site so ingest has a site_id to use.
  const site = await getOrCreateSite();
  console.log(`Site ready: #${site.id} "${site.name}" (${site.gsc_property})`);

  // Platform Administration, Phase 0 (PLATFORM-ADMIN-DESIGN.md §K): promote
  // COMPANY_SITE_ID's existing users from 062's default 'tenant_admin' to
  // 'platform_admin'. This needs process.env, which a static .sql file has
  // no access to, so it lives here alongside the other env-driven step
  // above. Guarded to only touch rows still at the default role, so it
  // never clobbers a role a Platform Admin deliberately set later — safe
  // to run on every deploy.
  const companySiteId = Number(process.env.COMPANY_SITE_ID);
  if (companySiteId) {
    const { rowCount } = await pool.query(
      `UPDATE users SET role = 'platform_admin' WHERE site_id = $1 AND role = 'tenant_admin'`,
      [companySiteId]
    );
    if (rowCount) console.log(`Promoted ${rowCount} COMPANY_SITE_ID user(s) to platform_admin.`);
  }

  await pool.end();
  console.log('Migrations complete.');
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
