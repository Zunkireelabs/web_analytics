import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { getSiteById } from '../store/read.js';
import { deriveRelatedGuidesTemplate, mutateMap } from '../implementers/lib/related-guides-derive.js';

// Works out how a site shows related guides, so the agent can draw them the same way.
//   1. If the site already shows related guides as cards on any of its pages, that card is copied (its own classes, structure and spacing).
//   2. If it has none, its live look is MEASURED in a real browser (text and background colours, heading font, typical corner radius, container width,
//      section padding) and saved so the platform's standard card can be built from it. That card is flagged for a person to approve the first time.
// Nothing is saved unless --apply is passed; a site with areas needs --area.
//
//   node server/scripts/derive-related-guides-template.js --site-id 8862 [--pages https://a/x,https://a/y] [--area business] [--apply]

export { mutateMap, samplePages, candidatePages } from '../implementers/lib/related-guides-derive.js';

async function main() {
  const args = process.argv.slice(2); const val = (k) => { const i = args.indexOf(`--${k}`); return i === -1 ? null : args[i + 1]; };
  const siteId = Number(val('site-id')); if (!siteId) throw new Error('Usage: derive-related-guides-template.js --site-id <id> [--pages a,b] [--area name] [--apply]');
  const site = await getSiteById(siteId); if (!site) throw new Error(`No site ${siteId}.`);
  const explicit = val('pages')?.split(',').filter(Boolean) || null;
  const derived = await deriveRelatedGuidesTemplate(site, { explicitPages: explicit });
  if (!derived) throw new Error('Nothing could be worked out for this site (no readable pages, or no browser to measure with).');
  if (derived.kind === 'card') console.log(`FOUND the site's own card on ${derived.from} ("${derived.relatedGuidesCard.heading}").\n  card: ${derived.relatedGuidesCard.card.slice(0, 260)}`);
  else console.log('No related-guides card on those pages. Measured look for the platform standard card:\n', JSON.stringify(derived.relatedGuidesStandard, null, 2));
  if (!args.includes('--apply')) { console.log('\nPrint only. Pass --apply to save it to the site\'s map.'); return; }
  const { patchUrlFileMap } = await import('../db.js');
  await patchUrlFileMap(siteId, (map) => mutateMap(map, { area: val('area'), relatedGuidesCard: derived.relatedGuidesCard || null, relatedGuidesStandard: derived.relatedGuidesStandard || null }));
  console.log('Saved.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(async () => { const { pool } = await import('../db.js'); await pool.end(); }).catch(async (e) => { console.error('derive-related-guides-template failed:', e.message); const { pool } = await import('../db.js'); await pool.end(); process.exit(1); });
}
