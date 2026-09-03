import 'dotenv/config';
import { pool } from '../db.js';
import { reconcileAllSites, reconcileSite, IDLE_RECLAIM_HOURS } from '../lib/action-center-reconciler.js';

// Manual entry point for lib/action-center-reconciler.js, which otherwise
// runs unattended at :35 each hour (cron.js).
//
// Exists for two reasons. First, dry-run: this prints exactly what the hourly
// pass would reclaim, classify, block and close WITHOUT writing anything, so
// the behaviour can be checked against real production data before it is
// trusted to run on its own. Second, on-demand catch-up after a deploy, so
// the first reconciliation doesn't have to wait for the next :35.
//
// It deliberately replaces two earlier one-off scripts in this directory
// (recover-stranded-unattended-drafts.js, recover-quality-gate-stuck-drafts.js).
// Each of those fixed one snapshot of one cause by hand and neither was ever
// scheduled, which is why 48 recommendations were sitting invisible behind
// stalled drafts on site 1 when this was written.
//
//   node server/scripts/reconcile-action-center.js                  (dry run, all sites)
//   node server/scripts/reconcile-action-center.js --site-id 1      (dry run, one site)
//   node server/scripts/reconcile-action-center.js --apply          (actually write)
//   node server/scripts/reconcile-action-center.js --idle-hours 48  (a wider stall window)

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return flags;
}

function report({ siteId, stalled, failures }) {
  if (!stalled.drafts.length && !failures.classified && !Object.keys(failures.byPolicy).length) return;
  console.log(`\nSite ${siteId}`);
  if (stalled.drafts.length) {
    console.log(`  stalled drafts to reclaim: ${stalled.drafts.length}`);
    const byStatus = {};
    for (const d of stalled.drafts) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    for (const [status, n] of Object.entries(byStatus)) console.log(`    ${status}: ${n}`);
    if (stalled.reclaimed) console.log(`  reclaimed: ${stalled.reclaimed}, recommendations returned: ${stalled.reopened}, absorbed by an existing card: ${stalled.conflicts}`);
  }
  const policies = Object.entries(failures.byPolicy);
  if (policies.length) {
    console.log('  unclassified past failures, by verdict:');
    for (const [policy, n] of policies) console.log(`    ${policy}: ${n}`);
    if (failures.classified) console.log(`  recorded: ${failures.classified}, blocked pending a human: ${failures.blocked}, closed as already resolved: ${failures.resolved}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const apply = flags.apply === true;
  const idleHours = flags['idle-hours'] ? Number(flags['idle-hours']) : IDLE_RECLAIM_HOURS;
  const siteId = flags['site-id'] ? Number(flags['site-id']) : null;

  console.log(apply ? 'APPLYING changes.' : 'DRY RUN — nothing will be written. Re-run with --apply to commit.');
  console.log(`Stall window: ${idleHours}h without progress and no PR.`);

  if (siteId) {
    report(await reconcileSite(siteId, { idleHours, apply }));
  } else {
    const { results, totals } = await reconcileAllSites({ idleHours, apply });
    for (const r of results) report(r);
    console.log(`\nTotals — reclaimed ${totals.reclaimed}, returned ${totals.reopened}, classified ${totals.classified}, blocked ${totals.blocked}, resolved ${totals.resolved}`);
  }
  if (!apply) console.log('\nDry run complete. No rows were changed.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
