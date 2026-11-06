import 'dotenv/config';
import { requireWriteAllowed, announceDatabase } from '../lib/script-guard.js';
import { getSiteById } from '../store/read.js';
import { getTargetPlaces, setTargetPlaces } from '../store/target-places.js';
import { resolveMarketServiceTerms } from '../agents/lib/market-seed-terms.js';
import { buildMarketSeeds } from '../agents/lib/competitor-market-discovery.js';
import { localSeoNote, suggestLocalKeywords, isUkSite } from '../agents/lib/local-seo.js';
import { pool } from '../db.js';

// Where a LOCAL client works: the town it is based in, then the places around it, in priority order.
//
//   node server/scripts/set-target-places.js --site-id 8864                        # show what is set, and what it drives
//   node server/scripts/set-target-places.js --site-id 8864 --primary Northampton --nearby "Wellingborough,Daventry"
//                                                                                  # preview only: nothing is stored
//   node server/scripts/set-target-places.js --site-id 8864 --primary Northampton --nearby "..." --save
//
// Always prints what the places will DRIVE — the research phrases, the keywords worth tracking, and the guidance a
// content generator will be given — so a wrong list is caught before it is saved, not after a paid run.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const siteId = Number(args['site-id']);
  if (!Number.isInteger(siteId)) throw new Error('Pass --site-id <id>.');
  announceDatabase();

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site ${siteId}.`);
  console.log(`\nSite ${site.id} — ${site.name}${isUkSite(site) ? '  (UK market: British English applies)' : ''}`);

  const changing = args.primary !== undefined || args.nearby !== undefined;
  const nearby = typeof args.nearby === 'string' ? args.nearby.split(',').map((n) => n.trim()).filter(Boolean) : [];
  const proposed = changing ? { primary: typeof args.primary === 'string' ? args.primary : '', nearby } : null;

  const current = (await getTargetPlaces(siteId)) || [];
  console.log(`Currently set: ${current.length ? current.map((p) => (p.tier === 'primary' ? `${p.name} (based here)` : p.name)).join(' → ') : '(none)'}`);

  // Preview what the places would drive, using the would-be list when one was given.
  const preview = proposed
    ? { ...site, target_places: [...(proposed.primary ? [{ name: proposed.primary, tier: 'primary' }] : []), ...proposed.nearby.map((name) => ({ name, tier: 'nearby' }))] }
    : site;
  if (proposed) console.log(`Would set:     ${preview.target_places.map((p) => p.name).join(' → ') || '(none)'}`);

  const services = await resolveMarketServiceTerms(siteId);
  console.log(`\nServices known: ${services.terms.length ? services.terms.join(', ') : '(none yet — approve what discovery proposed first)'}  [${services.source || 'none'}]`);
  if (services.terms.length) {
    const seeds = buildMarketSeeds({ services: services.terms, declaredPlaces: preview.target_places || [] });
    console.log(`\nResearch would ask about ${seeds.length} phrase(s), home town first:`);
    seeds.slice(0, 16).forEach((s) => console.log(`  ${s}`));
    if (seeds.length > 16) console.log(`  … and ${seeds.length - 16} more`);
    const track = suggestLocalKeywords(preview, services.terms);
    if (track.length) console.log(`\nWorth tracking (primary place only):\n${track.map((k) => `  ${k}`).join('\n')}`);
  }
  const note = localSeoNote(preview);
  if (note) console.log(`\nContent generators would be told:\n  ${note}`);

  if (!proposed) return;
  if (!args.save) { console.log('\n(Preview only. Add --save to store it.)'); return; }
  requireWriteAllowed(args);
  const saved = await setTargetPlaces(siteId, proposed);
  console.log(`\nSaved: ${saved.map((p) => p.name).join(' → ') || '(cleared)'}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
