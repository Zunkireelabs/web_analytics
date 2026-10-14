import 'dotenv/config';
import { pool } from '../db.js';
import { listOpenRecommendations, closeRecommendation } from '../store/recommendations.js';
import { getSiteById } from '../store/read.js';
import { verifyRecommendation, isAlreadyResolved } from '../generators/lib/verification-layer.js';

// One-off backlog cleanup: runs each open recommendation's own pre-flight
// (generators/lib/verification-layer.js — the same check auto-remediation.js
// now runs before every draft attempt) and supersedes the ones whose premise
// is already false on the LIVE page. Only 'already_resolved' closes anything;
// a fetch failure or any other decision leaves the row untouched. Written for
// chayceproperties.com's 20 schema recommendations that asked for a type the
// page already carried (ai-visibility's entity-schema rule, since fixed), but
// it is generic over any generator that implements verifyCurrentState.
//
//   node server/scripts/close-already-resolved-recommendations.js --site-id <id> [--type schema]          (dry run, default)
//   node server/scripts/close-already-resolved-recommendations.js --site-id <id> [--type schema] --apply  (actually supersede)

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = Number(flags['site-id']);
  if (!siteId) throw new Error('Usage: close-already-resolved-recommendations.js --site-id <id> [--type <recommendation_type>] [--apply]');
  const type = typeof flags.type === 'string' ? flags.type : null;
  const apply = !!flags.apply;

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`Site #${siteId} not found`);

  const recs = (await listOpenRecommendations(siteId)).filter((r) => !type || r.recommendation_type === type);
  console.log(`Site #${siteId} (${site.name}) — ${recs.length} open recommendation(s)${type ? ` of type "${type}"` : ''}`);
  console.log(`Mode: ${apply ? 'APPLY (will supersede)' : 'DRY RUN (pass --apply to actually close these)'}\n`);

  let resolved = 0;
  for (const rec of recs) {
    const v = await verifyRecommendation(rec, { site });
    if (isAlreadyResolved(v)) {
      resolved++;
      console.log(`  rec ${rec.id} (${rec.recommendation_type}) ${rec.page || ''} — already resolved: ${v.reason}`);
      if (apply) await closeRecommendation(rec.id);
    } else {
      console.log(`  rec ${rec.id} (${rec.recommendation_type}) ${rec.page || ''} — kept open (${v.decision}: ${v.reason})`);
    }
  }
  console.log(`\n${resolved} of ${recs.length} already resolved${apply ? ' and closed.' : '. Re-run with --apply to close them.'}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
