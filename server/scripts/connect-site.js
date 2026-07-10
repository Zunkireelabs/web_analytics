import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { pool, updateSiteConnection } from '../db.js';
import { getSiteById } from '../store/read.js';

// Attach GSC/GA4 (and optionally a report email recipient / logo) to a site
// that was already created via `npm run create-client` with no properties
// connected yet.
//
//   node server/scripts/connect-site.js --site-id <id> \
//     --gsc-property "sc-domain:example.com" \
//     --ga4-property-id 123456789 \
//     [--email-to client-contact@example.com] \
//     [--logo path/to/logo.svg]

const MIME_BY_EXT = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

function logoToDataUrl(path) {
  const ext = extname(path).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error(`Unsupported logo file type "${ext}" — use .svg, .png, or .jpg/.jpeg.`);
  const data = readFileSync(path);
  return `data:${mime};base64,${data.toString('base64')}`;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = Number(flags['site-id']);
  if (!siteId) {
    throw new Error(
      'Usage: connect-site.js --site-id <id> --gsc-property "sc-domain:example.com" --ga4-property-id 123456789 [--email-to you@client.com] [--logo path/to/logo.svg]'
    );
  }

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site found with id ${siteId}.`);

  const update = {};
  if (flags['gsc-property'] != null) update.gscProperty = flags['gsc-property'];
  if (flags['ga4-property-id'] != null) update.ga4PropertyId = flags['ga4-property-id'];
  if (flags['email-to'] != null) update.reportEmailTo = flags['email-to'];
  if (flags.logo != null) update.logoDataUrl = logoToDataUrl(flags.logo);

  if (!Object.keys(update).length) {
    throw new Error('Pass at least one of --gsc-property, --ga4-property-id, --email-to, --logo.');
  }

  const updated = await updateSiteConnection({ siteId, ...update });
  console.log(`Updated site #${updated.id} "${updated.name}":`);
  if (update.gscProperty !== undefined) console.log(`  gsc_property → ${updated.gsc_property}`);
  if (update.ga4PropertyId !== undefined) console.log(`  ga4_property_id → ${updated.ga4_property_id}`);
  if (update.reportEmailTo !== undefined) console.log(`  report_email_to → ${updated.report_email_to}`);
  if (update.logoDataUrl !== undefined) console.log('  logo_data_url → updated');

  if (updated.gsc_property && updated.ga4_property_id) {
    console.log('Both GSC and GA4 are connected — this site will be picked up on the next daily/cron cycle.');
  } else {
    console.log('Still missing one of GSC/GA4 — this site is not yet included in automated ingestion.');
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('connect-site failed:', err.message);
    await pool.end();
    process.exit(1);
  });
