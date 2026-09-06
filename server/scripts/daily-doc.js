import 'dotenv/config';
import { pool, getOrCreateSite } from '../db.js';
import { runDailyDocReport } from '../report/daily-doc.js';
import { markDailyDocDone } from '../store/upsert.js';

// Manual daily doc entry:
//   npm run daily-doc                  → today's report date (3 days ago, same as the daily job)
//   npm run daily-doc -- 2026-06-19    → a specific date
async function main() {
  const date = process.argv[2] || (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 3);
    return d.toISOString().slice(0, 10);
  })();
  const site = await getOrCreateSite();
  const r = await runDailyDocReport(site, date);
  await markDailyDocDone(site.id, date);
  console.log(`\n${date} written to daily doc.`);
  console.log(`Doc: ${r.url}\n`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Daily doc failed:', err.message);
    await pool.end();
    process.exit(1);
  });
