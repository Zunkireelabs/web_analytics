import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { discoverBrandColor } from '../agents/lib/brand-color-discovery.js';
import { normalizeHex } from '../report/brand.js';

// Suggest a project's report colour from its own website (theme-color tag, then SVG logo fill).
//   node server/scripts/detect-brand-color.js --site-id <id>            show the suggestion only (default)
//   node server/scripts/detect-brand-color.js --site-id <id> --write    set sites.brand_color, only if it is empty
// brand_color always wins over everything else, so a site that already has one is never touched.
const args = process.argv.slice(2);
const id = Number(args[args.indexOf('--site-id') + 1]);
const write = args.includes('--write');
if (!Number.isInteger(id)) { console.error('usage: --site-id <id> [--write]'); process.exit(1); }

try {
  const site = await getSiteById(id);
  if (!site) throw new Error(`site ${id} not found`);
  if (normalizeHex(site.brand_color)) { console.log(`#${id} ${site.name}: brand_color already set (${site.brand_color}), leaving it.`); }
  else {
    const r = await discoverBrandColor(site.website_domain, { logoDataUrl: site.logo_data_url });
    if (!r.ok) console.log(`#${id} ${site.name}: no colour found: ${r.error}`);
    else {
      console.log(`#${id} ${site.name}: ${r.color} (${r.source})`);
      if (write) {
        await pool.query('UPDATE sites SET brand_color = $1 WHERE id = $2 AND brand_color IS NULL', [r.color, id]);
        console.log('  brand_color written.');
      } else console.log('  dry run, nothing written. Add --write to set it.');
    }
  }
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await pool.end(); }
