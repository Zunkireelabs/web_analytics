import 'dotenv/config';
import { requireWriteAllowed, announceDatabase } from '../lib/script-guard.js';
import { getSiteById } from '../store/read.js';
import { discoverCapabilities, discoverCapabilitiesIfNone } from '../lib/capability-discovery.js';
import { query, pool } from '../db.js';

// Reads what a client sells from their own site and PROPOSES it for review (nothing here approves anything).
// For clients who arrived before discovery existed.
//
//   node server/scripts/discover-capabilities.js --site-id 8864             # show what it would propose, store nothing
//   node server/scripts/discover-capabilities.js --site-id 8864 --save      # propose them (status 'proposed')
//   node server/scripts/discover-capabilities.js --all                      # every site with NO capability at all, dry
//   node server/scripts/discover-capabilities.js --all --save               # ...and propose for each of them
//
// One page fetch and one model call per site. `--all` only ever touches sites that have no capability in any state,
// so a list a person has curated is never added to.

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

async function one(site, { save }) {
  const out = save ? await discoverCapabilitiesIfNone(site) : await discoverCapabilities(site, { save: false });
  console.log(`\nSite ${site.id} — ${site.name}`);
  if (out.skipped && !out.candidates?.length) { console.log(`  nothing proposed: ${out.skipped}`); return out; }
  for (const c of out.candidates) {
    console.log(`  ${save ? '+' : '·'} ${c.name}${c.category ? ` (${c.category})` : ''}`);
    console.log(`      from the page: "${c.evidence}"`);
  }
  console.log(save ? `  proposed ${out.proposed} for review.` : '  (dry run — nothing stored. Add --save to propose them.)');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  announceDatabase();
  if (args.save) requireWriteAllowed(args);

  if (args['site-id']) {
    const site = await getSiteById(Number(args['site-id']));
    if (!site) throw new Error(`No site ${args['site-id']}.`);
    await one(site, { save: !!args.save });
    return;
  }
  if (!args.all) throw new Error('Pass --site-id <id> or --all.');

  const { rows } = await query(
    `SELECT s.id FROM sites s WHERE NOT EXISTS (SELECT 1 FROM product_capabilities c WHERE c.site_id = s.id) ORDER BY s.id`
  );
  console.log(`${rows.length} site(s) have no capability in any state.`);
  for (const r of rows) {
    const site = await getSiteById(r.id);
    await one(site, { save: !!args.save }).catch((err) => console.log(`  site ${r.id} failed: ${err.message}`));
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
