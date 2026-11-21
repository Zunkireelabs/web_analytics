// Removes the fake "pages" a bug put into the page-check tables: a recommendation KEY like `<page>::<link>` was handed to the page checker as
// if it were a URL (fixed in recommendation-coordinator.js, realPageOf), so rows such as
//   https://zunkireelabs.com/blog/what-is-flow-ai::https://clutch.co/profile/zunkiree-labs
// were inspected and stored: 45 rows across zunkireelabs, admizz and chayce. No real page contains "::", and these rows only inflate the
// "unknown to Google" counts and spent URL-inspection quota. Only rows whose page contains "::" are touched.
//
//   node server/scripts/delete-junk-page-checks.js            # dry run: counts and examples, nothing deleted
//   node server/scripts/delete-junk-page-checks.js --apply    # delete them
import 'dotenv/config';
import { pool } from '../db.js';

export const JUNK_PAGE_SQL = "page LIKE '%::%'";
const TABLES = ['technical_seo_checks', 'agent_page_rotation', 'page_inventory'];

async function main() {
  const apply = process.argv.includes('--apply');
  for (const table of TABLES) {
    const { rows } = await pool.query(`SELECT site_id, count(*)::int AS n, min(page) AS example FROM ${table} WHERE ${JUNK_PAGE_SQL} GROUP BY site_id ORDER BY site_id`);
    const total = rows.reduce((n, r) => n + r.n, 0);
    console.log(`${table}: ${total} junk row(s)${rows.length ? ' — ' + rows.map((r) => `site ${r.site_id}: ${r.n}`).join(', ') : ''}`);
    if (rows[0]) console.log(`  e.g. ${rows[0].example}`);
    if (apply && total) { const del = await pool.query(`DELETE FROM ${table} WHERE ${JUNK_PAGE_SQL}`); console.log(`  deleted ${del.rowCount}`); }
  }
  if (!apply) console.log('\nDry run: nothing deleted. Re-run with --apply to delete them.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end(); process.exit(1); });
}
