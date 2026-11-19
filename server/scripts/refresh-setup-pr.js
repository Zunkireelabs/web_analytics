import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { updateSetupPrResult } from '../store/setup-pr.js';
import { runDiscovery } from '../discovery/run-discovery.js';
import { refreshSetupPr } from '../implementers/lib/setup-pr.js';

// Rebuilds a project's EXISTING setup PR in place, from the default branch as it is now (the page mapping and the engine may have
// improved since it opened). The same PR keeps its number and its comments; its branch becomes one fresh commit and its description is
// rewritten. No second PR is opened. Refuses if anyone else has added a commit to the branch.
//
//   node server/scripts/refresh-setup-pr.js --site-id 8871            CHECK: prints what the PR would contain, changes nothing
//   node server/scripts/refresh-setup-pr.js --site-id 8871 --yes      rebuilds it
//
// The PR number and branch come from what the setup job recorded (sites.setup_pr_result).

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };

async function main() {
  const siteId = Number(flag('site-id')); const write = flag('yes') === true;
  if (!siteId) { console.error('Usage: node server/scripts/refresh-setup-pr.js --site-id <id> [--yes]'); process.exit(1); }
  const site = await getSiteById(siteId);
  if (!site) { console.error(`Site ${siteId} not found.`); process.exit(1); }
  const prev = site.setup_pr_result || {};
  if (!prev.branch || !prev.prNumber) { console.error(`Site ${siteId} has no recorded setup PR (setup_pr_result: ${JSON.stringify(prev).slice(0, 120)}).`); process.exit(1); }
  console.log(`\n=== Site ${siteId} "${site.name}": setup PR #${prev.prNumber} on ${prev.branch}  (was ${prev.files} files, ${prev.markers} markers; coverage ${JSON.stringify(prev.coverage)})`);

  let stack = null;
  try { stack = (await runDiscovery(site))?.technology?.framework?.name || null; } catch { /* the saved mapping is used */ }
  const fresh = (await getSiteById(siteId)) || site;
  const r = await refreshSetupPr(fresh, { branch: prev.branch, prNumber: prev.prNumber, dryRun: !write, stack });
  if (!r.ok) { console.log(`REFUSED: ${r.reason}${r.foreign ? ` (${r.foreign.join('; ')})` : ''}`); process.exit(2); }
  if (r.reason === 'nothing-to-add') { console.log('Nothing to add: the PR is left as it is.'); return; }
  const c = r.summary.coverage;
  console.log(`NOW: ${r.summary.files} files, ${r.summary.markers} markers.  Pages ready ${c.ready}, partly ready ${c.partial}, no template known ${c.unmapped}.`);
  r.plan.files.slice(0, 10).forEach((f) => console.log(`  + ${f.path}: ${f.added.join(', ')}`));
  if (r.plan.files.length > 10) console.log(`  ... and ${r.plan.files.length - 10} more`);
  if (!write) { console.log('\nCHECK ONLY. Nothing was changed. Add --yes to rebuild the PR.'); return; }
  await updateSetupPrResult(siteId, { ...prev, files: r.summary.files, markers: r.summary.markers, coverage: c, refreshedAt: new Date().toISOString() });
  console.log(`\nREBUILT: PR #${prev.prNumber} now shows the new content.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
