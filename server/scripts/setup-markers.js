import 'dotenv/config';
import { pool } from '../db.js';
import { setupMarkersForSite } from '../implementers/lib/marker-setup-run.js';

// Markers-only setup PR for a connected site (implementers/lib/marker-setup.js). A DRY RUN unless --open is passed: it reports which
// files would get which markers and what could not be placed, and writes nothing to GitHub.
//
//   node server/scripts/setup-markers.js --site-id <id> [--open]
//
// The site must opt in first: url_file_map.markerSetup = { "enabled": true }.
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const siteId = Number(flag('site-id'));
if (!siteId) { console.error('Usage: node server/scripts/setup-markers.js --site-id <id> [--open]'); process.exit(1); }
try {
  const result = await setupMarkersForSite(siteId, { open: flag('open') === true });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
