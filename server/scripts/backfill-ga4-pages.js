import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { backfillGa4Pages } from '../lib/ga4-pages-backfill.js';

// Fill a project's GA4 "Top pages" history (migration 245) by hand.
//   npm run ... -- node server/scripts/backfill-ga4-pages.js --site-id 3 [--days 35]
// Fetches only days that had traffic and no page list yet; running it twice does nothing the second time.
// It WRITES to whatever DATABASE_URL points at and reads that site's Google Analytics, so the target is printed first.
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
  const siteId = Number(flag('--site-id'));
  const days = flag('--days') ? Number(flag('--days')) : undefined;
  if (!Number.isInteger(siteId) || siteId <= 0) throw new Error('Pass --site-id <number>.');
  console.log(`Database host: ${new URL(process.env.DATABASE_URL).hostname}`);
  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site found with id ${siteId}.`);
  console.log(JSON.stringify(await backfillGa4Pages(site, { days })));
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
