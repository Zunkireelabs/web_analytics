// One-off script for Admizz (site 8862), 2026-09-17.
//
// Confirmed against the live repo (src/app/<slug>/page.tsx for each URL
// below) that every one of these pages is the same page-data-object shape
// adapters/page-data-object.js already exists for: a `page.tsx` with no JSX
// body at all, returning e.g. `<CountryPageTemplate data={usaData} />`,
// where `usaData`/`pageData` is a real local `const ... = {...}` in the
// same file with an existing `faqItems` array. They were never wired to the
// `page-data-object` adapter for the `faq` action type, so every FAQ draft
// for them fell back to the default marker-merge implementer, which
// correctly refuses ('self-closing-root-no-body') because there is no JSX
// to insert into — 9 of today's (2026-09-17) 69 Admizz abandons.
//
// Two other pages hit the exact same failure today but are NOT included
// here: study-in-canada-from-nepal and study-in-france-from-nepal already
// HAD this adapter configured and still failed — that was a separate,
// already-fixed bug in resolveFaqRenderMode (server/implementers/lib/
// faq-render-mode.js) misrouting page-data-object pages through the
// generic content scan instead of decideFaqRenderModeForDataDrivenPage.
// janakpur is also excluded: its data object is imported from
// `@/data/cities/janakpur`, not declared locally in page.tsx, which
// page-data-object.js's own findPageDataObjectRange explicitly does not
// follow — configuring it would trade one honest refusal for another, not
// unlock a ship.
//
// Idempotent — safe to re-run; each write only adds the adapter if absent.
//
// Usage: node server/scripts/apply-admizz-faq-page-data-object-fix.js
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SITE_ID = 8862;
const PAGES = [
  '/study-in-nepal',
  '/study-in-the-usa',
  '/study-in-usa-from-nepal',
  '/study-in-denmark-from-nepal',
  '/study-in-newzealand-from-nepal',
];

async function main() {
  const { rows } = await pool.query('select url_file_map from sites where id=$1', [SITE_ID]);
  const map = rows[0].url_file_map;

  let changed = false;
  for (const url of PAGES) {
    const entry = map.pages[url];
    if (!entry) {
      console.log(`[admizz] ${url}: no page entry in url_file_map — skipping (nothing safe to attach to).`);
      continue;
    }
    if (entry.adapters?.faq) {
      console.log(`[admizz] ${url}: faq adapter already configured — skipping.`);
      continue;
    }
    entry.adapters = { ...entry.adapters, faq: { id: 'page-data-object' } };
    changed = true;
    console.log(`[admizz] ${url}: added faq -> page-data-object`);
  }

  if (!changed) {
    console.log('[admizz] nothing to do — all pages already configured.');
    await pool.end();
    return;
  }

  await pool.query('update sites set url_file_map=$1 where id=$2', [JSON.stringify(map), SITE_ID]);
  await pool.end();
  console.log('Done. The next auto-remediation catch-up pass (hourly, :35) will re-evaluate the affected FAQ recommendations.');
}

main().catch((err) => { console.error(err); process.exit(1); });
