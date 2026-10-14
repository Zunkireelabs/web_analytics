import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { deriveExpandStructureSpec } from '../design-agent/lib/expand-structure-spec.js';
import { saveExpandStructureSpec } from '../store/expand-structure.js';

// Derive the shared expand-content structure reference from ONE site's
// captured pages. Deliberately manual and never run from cron: re-deriving
// changes the structure every opted-in tenant is nudged toward, so it is a
// decision, not a background refresh.
//
//   node server/scripts/derive-expand-structure-spec.js --site-id 1            # print only
//   node server/scripts/derive-expand-structure-spec.js --site-id 1 --apply    # save a new version
//
// Reads profile.pages[] (what the Design Agent already captured), takes only
// non-chrome sections, and reduces them to roles/shapes/counts. No class,
// colour or length can reach the saved spec: the validator refuses it.

const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(`--${k}`); return i === -1 ? null : args[i + 1]; };

async function main() {
  const siteId = Number(val('site-id'));
  if (!siteId) throw new Error('Usage: derive-expand-structure-spec.js --site-id <id> [--apply]');
  const site = await getSiteById(siteId);
  const pages = site?.url_file_map?.siteRoot?.designProfile?.pages;
  if (!Array.isArray(pages) || !pages.length) throw new Error(`Site ${siteId} has no captured pages in its design profile — run the Design Agent first.`);

  const result = deriveExpandStructureSpec(pages);
  if (!result.ok) throw new Error(`Derived spec failed validation: ${result.errors.join('; ')}`);
  console.log(`Derived from ${result.pagesObserved} captured page(s) of site ${siteId}:`);
  console.log(JSON.stringify(result.spec, null, 2));

  if (args.includes('--apply')) {
    const saved = await saveExpandStructureSpec(result.spec, { derivedFromSiteId: siteId, pagesObserved: result.pagesObserved });
    console.log(`Saved as version ${saved.version}.`);
  } else {
    console.log('Print only — pass --apply to save it as a new version.');
  }
}

main().then(() => pool.end()).catch(async (err) => { console.error('derive-expand-structure-spec failed:', err.message); await pool.end(); process.exit(1); });
