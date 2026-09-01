import 'dotenv/config';
import { pool } from '../db.js';
import { isKnownPlatformDomain } from '../agents/lib/competitor-analysis.js';

// One-time backfill for migration 133 (competitor_profiles.excluded_reason):
// every row written before that migration has excluded_reason = NULL, which
// is indistinguishable from "genuinely a real competitor" — so a site whose
// discovery run predates this migration (e.g. Zunkiree's own facebook.com/
// instagram.com/linkedin.com/github.com/google.com rows) reads as having
// real competitors it does not have. This re-classifies EVERY tenant's rows
// identically, using the same generic isKnownPlatformDomain() list the
// live discovery pipeline now applies going forward — never scoped to one
// site, never a per-client list.
//
//   node server/scripts/backfill-competitor-excluded-reason.js            # dry run, prints only
//   node server/scripts/backfill-competitor-excluded-reason.js --commit   # writes to the DB
//
// Dry run is the default deliberately, same convention as
// backfill-engineering-lessons.js — review the printed plan before writing.

function parseArgs(argv) {
  return { commit: argv.includes('--commit') };
}

async function main() {
  const { commit } = parseArgs(process.argv.slice(2));

  const { rows } = await pool.query(
    `SELECT id, site_id, domain, excluded_reason FROM competitor_profiles ORDER BY site_id, domain`
  );

  const toPlatform = rows.filter((r) => r.excluded_reason == null && isKnownPlatformDomain(r.domain));
  const alreadyExcluded = rows.filter((r) => r.excluded_reason != null);
  const activeCompetitors = rows.filter((r) => r.excluded_reason == null && !isKnownPlatformDomain(r.domain));

  console.log(`Scanned ${rows.length} competitor_profiles row(s) across every tenant.`);
  console.log(`  Already excluded: ${alreadyExcluded.length}`);
  console.log(`  Reclassifying as excluded_reason='platform': ${toPlatform.length}`);
  console.log(`  Left as active competitors: ${activeCompetitors.length}`);
  console.log();
  if (toPlatform.length) {
    console.log('Rows to reclassify (site_id, domain):');
    for (const r of toPlatform) console.log(`  [${r.site_id}] ${r.domain}`);
  }

  if (!commit) {
    console.log('\nDry run only — re-run with --commit to write these changes.');
    await pool.end();
    return;
  }

  for (const r of toPlatform) {
    await pool.query(`UPDATE competitor_profiles SET excluded_reason = 'platform' WHERE id = $1`, [r.id]);
  }
  console.log(`\nUpdated ${toPlatform.length} row(s).`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
