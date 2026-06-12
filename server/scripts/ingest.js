import 'dotenv/config';
import { pool, getOrCreateSite } from '../db.js';
import { ingestDate, runDailyIngest } from '../job.js';

// Manual ingest.
//   npm run ingest                 → run the standard daily window (GSC backfill + GA4 yesterday)
//   npm run ingest -- 2026-06-08   → ingest one explicit date for both sources
//   npm run ingest -- 2026-06-01 2026-06-08  → ingest an inclusive date range
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await runDailyIngest();
    console.log('Daily ingest complete.');
    return;
  }

  const site = await getOrCreateSite();
  const [start, end = start] = args;

  const dates = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  for (const date of dates) {
    const r = await ingestDate(site, date);
    console.log(
      `${date}  GSC ${r.gsc.clicks} clicks / ${r.gsc.impressions} impr   ` +
      `GA4 ${r.ga4.users} users / ${r.ga4.sessions} sessions`
    );
  }
  console.log(`Ingested ${dates.length} day(s).`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Ingest failed:', err.message);
    await pool.end();
    process.exit(1);
  });
