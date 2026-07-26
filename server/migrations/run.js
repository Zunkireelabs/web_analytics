import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, getOrCreateSite } from '../db.js';

// Minimal migration runner: applies every *.sql file in this folder in order.
// SQL uses IF NOT EXISTS, so re-running is safe (idempotent).
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const files = readdirSync(here)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(here, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    await pool.query(sql);
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
