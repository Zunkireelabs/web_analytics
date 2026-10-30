// Dev tool: put one "needs your design choice" item into a project so the Action Center section can be seen and tried.
// It writes through the same store the agent will use (createDesignChoice). It REFUSES to run unless DATABASE_URL points
// at this machine: this is for the local dev database only, never a shared or live one.
//   DATABASE_URL=postgres://...@localhost:55432/analytics node server/scripts/seed-design-choice.js --site 1
import { pool } from '../db.js';
import { createDesignChoice } from '../store/design-choices.js';
import { designOptionsFor } from '../lib/fix-design-options.js';

const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`Refusing to run: DATABASE_URL host is "${host || 'unset'}", not this machine. This script is for the local dev database only.`);
  process.exit(1);
}
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null; };
const siteId = Number(arg('site'));
if (!siteId) { console.error('Usage: --site <site id>'); process.exit(1); }

const { rows: [site] } = await pool.query('SELECT id, name, url_file_map FROM sites WHERE id = $1', [siteId]);
if (!site) { console.error(`No site ${siteId} in this database.`); process.exit(1); }

// The options are the project's OWN templates that can show an FAQ, exactly as the agent derives them.
const options = designOptionsFor('faq', site.url_file_map?.siteRoot?.componentTemplates);
if (!options.length) { console.error(`${site.name} has no real choice to offer: it needs at least two of its own FAQ templates (for example faq and qaContent).`); process.exit(1); }

const row = await createDesignChoice(siteId, {
  findingId: 'demo-faq-services', generatorId: 'faq', title: 'Add an FAQ block to /services', pageUrl: '/services',
  reason: 'The agent tried six times to add the FAQ block without changing how your page looks, and could not. Nothing was published and your site is unchanged.',
  attempts: [
    { what: 'Used your service-card style', result: 'Footer moved down 24px on phones' },
    { what: 'Narrowed the block to your page width', result: 'Text overflowed on tablet' },
    { what: 'Switched to your accordion component', result: 'Its styles were missing on this page' },
    { what: 'Loaded the accordion styles first', result: 'Heading spacing changed in the hero' },
    { what: 'Used your plain body style', result: 'Block looked different from the section above it' },
    { what: 'Matched spacing to the section above', result: 'Fixed on desktop, still 6px off on phone' },
  ],
  options,
});
console.log(`Seeded design choice #${row.id} for ${site.name} (site ${site.id}): ${row.title}, status ${row.status}, options: ${options.map((o) => `${o.key} (${o.name})`).join(', ')}`);
await pool.end();
