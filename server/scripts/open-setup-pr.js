import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { runDiscovery } from '../discovery/run-discovery.js';
import { planSetupPr, openSetupPr, setupBranchName } from '../implementers/lib/setup-pr.js';

// What the setup PR would do for ONE project, and (only with --open) doing it.
//
//   node server/scripts/open-setup-pr.js --site-id 8874              DRY RUN: reads the repo, prints the plan, pushes nothing
//   node server/scripts/open-setup-pr.js --site-id 8874 --open       opens the branch and the PR (never merges it)
//
// A dry run still learns the project first (the repo discovery that the scheduled job also runs) and may save a small detection result
// to the strategy cache; it opens no branch and no PR. Needs GitHub access for the project, like the daily run.

function flag(name) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); }

async function main() {
  const siteId = Number(flag('site-id'));
  if (!siteId) { console.error('Usage: node server/scripts/open-setup-pr.js --site-id <id> [--open]'); process.exit(1); }
  const open = flag('open') === true;

  let site = await getSiteById(siteId);
  if (!site) { console.error(`Site ${siteId} not found.`); process.exit(1); }
  console.log(`\n=== Site ${siteId} "${site.name}"  repo: ${site.repo_owner || '-'}/${site.repo_name || '-'}   Auto-fixes: ${site.auto_remediation_enabled ? 'on' : 'OFF'}   baseline: ${site.onboarded_at ? 'done' : 'NOT done'}`);
  if (!site.repo_owner || !site.repo_name) { console.error('No repository connected: nothing to plan.'); process.exit(1); }

  let stack = null;
  try {
    const found = await runDiscovery(site);
    stack = found?.technology?.framework?.name || null;
    site = (await getSiteById(siteId)) || site;
    console.log(`Learned the project: stack ${stack || 'not identified'}, ${found?.fileCount ?? '?'} files${found?.truncated ? ' (partial tree)' : ''}.`);
  } catch (err) { console.log(`(discovery failed, using the saved mapping: ${err.message})`); }

  const plan = await planSetupPr(site);
  const c = plan.coverage;
  console.log(`\nPages: ${plan.pagesSeen}   template files: ${plan.filesSeen}   already complete: ${plan.alreadyComplete}`);
  console.log(`Pages ready once merged: ${c.ready}   partly ready: ${c.partial}   no template known: ${c.unmapped}   unreadable: ${c.unknown}`);
  if (c.unmappedExamples.length) console.log(`  no-template examples: ${c.unmappedExamples.slice(0, 5).join(', ')}`);
  console.log(`\nWOULD ADD markers to ${plan.files.length} file(s)${plan.truncated ? ' (capped)' : ''}:`);
  for (const f of plan.files) console.log(`  + ${f.path}: ${f.added.join(', ')}`);
  const uniq = (xs, k) => [...new Map(xs.map((x) => [k(x), x])).values()];
  if (plan.unresolved.length) { console.log(`\nNO SAFE PLACE (${plan.unresolved.length}):`); for (const u of uniq(plan.unresolved, (x) => `${x.path}${x.markerName}`).slice(0, 15)) console.log(`  - ${u.path} (${u.markerName}): ${u.reason}`); }
  if (plan.skipped.length) { console.log(`\nSKIPPED (${plan.skipped.length}):`); for (const s of plan.skipped.slice(0, 15)) console.log(`  - ${s.path}${s.markerName ? ` (${s.markerName})` : ''}: ${s.reason}`); }

  if (!open) { console.log(`\nDRY RUN. Nothing was pushed. Branch it would use: ${setupBranchName(site)}\nTo open it: add --open`); return; }
  const r = await openSetupPr(site, plan, { stack });
  console.log(`\n${r.opened ? 'OPENED' : r.reason}: ${r.prUrl || ''}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
