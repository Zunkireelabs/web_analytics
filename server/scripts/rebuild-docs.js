import 'dotenv/config';
import { pool, query } from '../db.js';
import { getSiteById } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { getDocs } from '../auth/google.js';
import { runWeeklyDocReport } from '../report/weekly-doc.js';
import { runMonthlyDocReport } from '../report/monthly-doc.js';
import { runDailyDocReport } from '../report/daily-doc.js';

// Delete all body content from a Google Doc, leaving only the empty first paragraph.
async function clearDoc(docId) {
  const docs = getDocs();
  const { data } = await docs.documents.get({ documentId: docId });
  const content = data.body.content || [];
  const endIndex = content[content.length - 1]?.endIndex ?? 1;
  if (endIndex <= 2) { console.log(`  doc ${docId} already empty`); return; }
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }] },
  });
  console.log(`  cleared doc ${docId} (was ${endIndex} chars)`);
}

// All distinct Mon–Sun week start dates (Mondays) that have any GSC data.
async function allWeekMondays(siteId) {
  const { rows } = await query(`
    SELECT DISTINCT to_char(date_trunc('week', date + interval '1 day'), 'YYYY-MM-DD') AS mon
    FROM gsc_daily WHERE site_id = $1 ORDER BY mon
  `, [siteId]);
  return rows.map((r) => r.mon);
}

// All complete calendar months (YYYY-MM) that are fully in the past.
async function allCompleteMonths(siteId) {
  const { rows } = await query(`
    SELECT DISTINCT to_char(date_trunc('month', date), 'YYYY-MM') AS ym
    FROM gsc_daily WHERE site_id = $1 ORDER BY ym
  `, [siteId]);
  // Keep only months fully in the past (not the current month).
  const now = new Date();
  const curYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return rows.map((r) => r.ym).filter((ym) => ym < curYm);
}

async function rebuildWeekly(site) {
  console.log('\n── Weekly doc ──');
  if (!site.weekly_doc_id) { console.log('  no weekly_doc_id — skipping'); return; }

  await clearDoc(site.weekly_doc_id);

  const mondays = await allWeekMondays(site.id);
  console.log(`  re-generating ${mondays.length} weeks (oldest → newest so newest lands on top)…`);

  for (const mon of mondays) {
    try {
      const r = await runWeeklyDocReport(site, mon);
      console.log(`  ✓ ${r.start} → ${r.end}`);
    } catch (err) {
      console.error(`  ✗ week of ${mon}: ${err.message}`);
    }
  }
}

async function rebuildMonthly(site) {
  console.log('\n── Monthly doc ──');
  if (!site.monthly_doc_id) { console.log('  no monthly_doc_id — skipping'); return; }

  await clearDoc(site.monthly_doc_id);

  const months = await allCompleteMonths(site.id);
  console.log(`  re-generating ${months.length} months (oldest → newest)…`);

  for (const ym of months) {
    try {
      const r = await runMonthlyDocReport(site, ym);
      if (r) console.log(`  ✓ ${r.start} → ${r.end}`);
    } catch (err) {
      console.error(`  ✗ month ${ym}: ${err.message}`);
    }
  }
}

async function rebuildDaily(site) {
  console.log('\n── Daily doc ──');
  if (!site.daily_doc_id) { console.log('  no daily_doc_id — skipping'); return; }

  await clearDoc(site.daily_doc_id);

  const { rows } = await query(
    `SELECT DISTINCT to_char(date, 'YYYY-MM-DD') AS d FROM gsc_daily WHERE site_id = $1 ORDER BY d`,
    [site.id]
  );
  const dates = rows.map((r) => r.d);
  console.log(`  re-generating ${dates.length} days (oldest → newest so newest lands on top)…`);

  for (const d of dates) {
    try {
      await runDailyDocReport(site, d);
      console.log(`  ✓ ${d}`);
    } catch (err) {
      console.error(`  ✗ ${d}: ${err.message}`);
    }
  }
}

// Clears and fully regenerates Google Docs — destructive per site. Unlike
// monthly.js/executive-report.js (additive report generation), this does NOT
// default to sweeping every connected site, to avoid accidentally wiping
// every client's doc history in one command. Pass --site-id for one site, or
// --all to explicitly opt into rebuilding every connected site.
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site-id') flags.siteId = Number(argv[++i]);
    else if (argv[i] === '--all') flags.all = true;
  }
  return flags;
}

async function main() {
  const { siteId, all } = parseArgs(process.argv.slice(2));
  if (!siteId && !all) {
    throw new Error('Usage: rebuild-docs.js --site-id <id>   (or --all to rebuild every connected site)');
  }

  const sites = siteId
    ? [await getSiteById(siteId)].filter(Boolean)
    : await listConnectedSites();
  if (siteId && !sites.length) throw new Error(`No site found with id ${siteId}.`);

  for (const site of sites) {
    console.log(`\n=== Site: ${site.name} ===`);
    await rebuildWeekly(site);
    await rebuildMonthly(site);
    await rebuildDaily(site);
  }
  console.log('\nDone.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Rebuild failed:', err.message);
    await pool.end();
    process.exit(1);
  });
