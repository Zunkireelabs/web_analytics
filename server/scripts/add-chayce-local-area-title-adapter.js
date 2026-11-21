// Lets the meta-title fix work on chayce-properties' 20 local-area pages (/elderly-removals-<town>/).
//
// Those pages are not files: src/areas/local-area.njk paginates over src/_data/localAreas.json, and each page's title is that entry's
// `seoTitle`. Their recommendations were blocked with "No url_file_map entry resolves ...". This adds ONE pattern with a meta-title adapter
// (adapters/data-array-content.js, `idPrefix` option) that rewrites that entry's seoTitle and nothing else.
//
//   - The 20 towns are listed explicitly, not matched loosely, so /elderly-removals-faq and the other real pages are never caught.
//   - There is deliberately no `file`: mapping the shared template would make every other fix edit all 20 pages at once.
//   - The description is computed in the template (no data field), so only the title is written.
//
// Needs the adapter's `idPrefix` support deployed first; before that the pattern is harmless but does nothing.
// Dry run by default (reads, prints, writes nothing). Idempotent: a second --apply changes nothing.
//
//   node server/scripts/add-chayce-local-area-title-adapter.js            # show what would change
//   node server/scripts/add-chayce-local-area-title-adapter.js --apply    # write it
import 'dotenv/config';
import { pool, updateSiteRepoConfig } from '../db.js';

const SITE_ID = 8864;
const TOWNS = ['kettering', 'wellingborough', 'daventry', 'corby', 'rushden', 'towcester', 'brixworth', 'brackley', 'desborough', 'olney',
  'market-harborough', 'rugby', 'milton-keynes', 'bedford', 'leicester', 'oxford', 'cambridge', 'peterborough', 'coventry', 'banbury'];

export const LOCAL_AREA_PATTERN = Object.freeze({
  match: `^/elderly-removals-(${TOWNS.join('|')})/?$`,
  adapters: {
    'meta-title': {
      id: 'data-array-content', format: 'json-array', idField: 'slug', idPrefix: 'elderly-removals-',
      dataFile: 'src/_data/localAreas.json', fields: { title: 'seoTitle' },
    },
  },
});

export function withLocalAreaPattern(urlFileMap) {
  const patterns = Array.isArray(urlFileMap?.patterns) ? urlFileMap.patterns : [];
  if (patterns.some((p) => p.match === LOCAL_AREA_PATTERN.match)) return { changed: false, urlFileMap };
  return { changed: true, urlFileMap: { ...urlFileMap, patterns: [...patterns, LOCAL_AREA_PATTERN] } };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows } = await pool.query('SELECT id, name, url_file_map FROM sites WHERE id = $1', [SITE_ID]);
  if (!rows[0]) throw new Error(`Site ${SITE_ID} not found.`);
  const { changed, urlFileMap } = withLocalAreaPattern(rows[0].url_file_map || {});
  console.log(`Site ${SITE_ID} (${rows[0].name}): url_file_map has ${Object.keys(rows[0].url_file_map?.pages || {}).length} pages and ${(rows[0].url_file_map?.patterns || []).length} pattern(s).`);
  if (!changed) { console.log('The local-area pattern is already there. Nothing to do.'); return; }
  console.log(`Would add 1 pattern:\n${JSON.stringify(LOCAL_AREA_PATTERN, null, 2)}`);
  if (!apply) { console.log('\nDry run: nothing written. Re-run with --apply to write it.'); return; }
  await updateSiteRepoConfig({ siteId: SITE_ID, urlFileMap });
  console.log('\nWritten. Everything else in url_file_map is unchanged.');
}

// Only runs when invoked directly, so the test can import the helpers without touching the database.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end(); process.exit(1); });
}
