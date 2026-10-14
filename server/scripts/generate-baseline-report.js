import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { buildBaselineReport } from '../agents/lib/baseline-report.js';

// One-off backfill/regenerate for a site's baseline_reports row — for
// clients onboarded before this feature existed, or whose automatic
// generation (runBaselineSequence, server/routes/clients.js) failed.
//
//   node server/scripts/generate-baseline-report.js --site-id <id>
//
// Mirrors the same generator (agents/lib/baseline-report.js) the internal
// "Generate Now" route (POST /internal/baseline-report/:siteId/generate)
// calls, so a CLI run and a UI click produce an identical report.

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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = Number(flags['site-id']);
  if (!siteId) throw new Error('Pass --site-id <id>.');

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site found with id ${siteId}.`);

  const report = await buildBaselineReport(siteId);
  console.log(`Generated baseline report for site #${site.id} "${site.name}" at ${report.generated_at}.`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('generate-baseline-report failed:', err.message);
    await pool.end();
    process.exit(1);
  });
