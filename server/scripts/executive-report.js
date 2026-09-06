import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { runExecutiveDocReport } from '../report/executive-doc.js';

// Manual AI Executive Report:
//   npm run executive-report                          → previous full Mon–Sun week, every connected site
//   npm run executive-report -- 2026-06-02              → week containing that date, every connected site
//   npm run executive-report -- 2026-06-02 --site-id 3  → one site only
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
    const r = await runExecutiveDocReport(site, anchor);
    console.log(`\n${site.name} — week ${r.start} → ${r.end} written.`);
    console.log(`Doc: ${r.url}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('AI Executive Report failed:', err.message);
    await pool.end();
    process.exit(1);
  });
