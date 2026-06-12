import 'dotenv/config';
import { pool, getOrCreateSite } from '../db.js';
import { runWeeklyDocReport } from '../report/weekly-doc.js';

// Manual weekly report:
//   npm run weekly                  → the previous full Mon–Sun week
//   npm run weekly -- 2026-06-02    → the Mon–Sun week containing that date
async function main() {
  const anchor = process.argv[2]; // optional YYYY-MM-DD
  const site = await getOrCreateSite();
  const r = await runWeeklyDocReport(site, anchor);
  console.log(`\nWeek ${r.start} → ${r.end} written.`);
  console.log(`Doc: ${r.url}\n`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Weekly report failed:', err.message);
    await pool.end();
    process.exit(1);
  });
