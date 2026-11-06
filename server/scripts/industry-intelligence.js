import 'dotenv/config';
import { requireWriteAllowed, announceDatabase } from '../lib/script-guard.js';
import { getIndustryIntelligence, refreshIndustryKnowledge, MIN_SITES, MIN_WORKSPACES, MIN_MEASURED, AGREEMENT } from '../lib/industry-intelligence.js';

// What the platform knows about a project's INDUSTRY (shared across projects), and how well each item is supported.
//
//   node server/scripts/industry-intelligence.js --site-id 8862            # knowledge for that project's industry
//   node server/scripts/industry-intelligence.js --site-id 8862 --json
//   node server/scripts/industry-intelligence.js --refresh                 # recompute shared knowledge from measured outcomes
//
// --refresh WRITES to the shared industry_knowledge table (counts only, no tenant data). It uses whatever DATABASE_URL is
// set, so never run it against the live database without the owner's OK.

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

const show = (title, items) => {
  console.log(`\n${title} (${items.length})`);
  for (const i of items) console.log(`  [${i.confidence}] ${i.surface.padEnd(7)} ${i.claim}${i.expiresAt ? `  (valid until ${String(i.expiresAt).slice(0, 10)})` : ''}`);
};

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  announceDatabase();
  if (flags.refresh) {
    requireWriteAllowed(flags);
    const r = await refreshIndustryKnowledge();
    console.log(JSON.stringify(r, null, 2));
    console.log(`\nA pattern is validated only with >= ${MIN_SITES} projects in >= ${MIN_WORKSPACES} workspaces, >= ${MIN_MEASURED} measured outcomes and >= ${Math.round(AGREEMENT * 100)}% agreement.`);
    return;
  }
  const siteId = Number(flags['site-id']);
  if (!siteId) { console.error('Usage: node server/scripts/industry-intelligence.js --site-id <id> [--json] | --refresh'); process.exit(1); }
  const out = await getIndustryIntelligence(siteId);
  if (flags.json) { console.log(JSON.stringify(out, null, 2)); return; }
  if (!out.classified) { console.log(`Project ${siteId}: ${out.reason}`); return; }
  console.log(`Project ${siteId}: industry "${out.industry}"${out.subIndustry ? ` / ${out.subIndustry}` : ''} (recorded by ${out.classification.source ?? 'unknown'}, ${out.classification.confidence ?? 'unknown'} confidence)`);
  show('VALIDATED across projects (observed association, not proven cause)', out.validated);
  show('CONTRADICTED (projects disagree)', out.contradicted);
  show('STARTING POINTS (general guidance, not yet confirmed by our own results)', out.startingPoints);
  show('EMERGING (not enough evidence yet, do not rely on)', out.emerging);
  show('STALE (past its valid-until date)', out.stale);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pool } = await import('../db.js');
  main().then(() => pool.end()).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
