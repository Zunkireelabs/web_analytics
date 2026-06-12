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

  await pool.end();
  console.log('Migrations complete.');
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
