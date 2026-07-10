import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { runMonthlyDocReport } from '../report/monthly-doc.js';

// Manual monthly report:
//   npm run monthly                          → previous complete month, every connected site
//   npm run monthly -- 2026-06                → June 2026, every connected site
//   npm run monthly -- 2026-06 --site-id 3    → June 2026, one site only
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site-id') { flags.siteId = Number(argv[++i]); }
    else positional.push(argv[i]);
  }
  return { anchor: positional[0], ...flags };
}

async function main() {
  const { anchor, siteId } = parseArgs(process.argv.slice(2));

  const sites = siteId
    ? [await getSiteById(siteId)].filter(Boolean)
    : await listConnectedSites();
  if (siteId && !sites.length) throw new Error(`No site found with id ${siteId}.`);

  for (const site of sites) {
    console.log(`\nSite: ${site.name}`);
    const r = await runMonthlyDocReport(site, anchor);
    if (!r) {
      console.log('  no data found for that month.');
      continue;
    }
    console.log(`  ${r.start} → ${r.end} written.`);
    console.log(`  Doc: ${r.url}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Monthly report failed:', err.message);
    await pool.end();
    process.exit(1);
  });
