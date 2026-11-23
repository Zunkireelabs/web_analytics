import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { repairFailingBatchPr } from '../lib/pr-build-repair.js';

// Reads the build of ONE pull request the agent opened and shows what build repair would do about a failure (lib/pr-build-repair.js).
//
//   node server/scripts/repair-pr-build.js --site-id 8871 --pr 15            DRY RUN: reads the PR, its checks and the failing log; writes nothing
//   node server/scripts/repair-pr-build.js --site-id 8871 --pr 15 --apply    also pushes ONE repair commit to the PR's own agent branch
//
// Only branches named action-center/batch-* are ever touched, only files the PR itself changed, and the PR is never merged.

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };

async function main() {
  const siteId = Number(flag('site-id')); const pr = Number(flag('pr')); const apply = flag('apply') === true;
  if (!siteId || !pr) { console.error('Usage: node server/scripts/repair-pr-build.js --site-id <id> --pr <number> [--apply]'); process.exit(1); }
  const site = await getSiteById(siteId);
  if (!site?.repo_owner || !site?.repo_name) { console.error(`Site ${siteId} has no repository.`); process.exit(1); }
  console.log(`\n=== Site ${siteId} "${site.name}"  ${site.repo_owner}/${site.repo_name}  PR #${pr}  ${apply ? 'APPLY' : 'DRY RUN'}`);
  const r = await repairFailingBatchPr(site, pr, { apply });
  console.log(`outcome: ${r.outcome}${r.reason ? `  (${r.reason})` : ''}`);
  if (r.failure) {
    console.log(`failing check: ${r.failure.check}  ${r.failure.url || ''}\nkind: ${r.failure.kind}\nfiles the PR changed that the log names: ${r.failure.files.join(', ') || '(none)'}\n--- log excerpt\n${r.failure.excerpt}\n---`);
  }
  for (const a of r.plan?.actions || []) console.log(`${apply ? 'DONE' : 'WOULD'} ${a.op.padEnd(7)} ${a.path}\n        ${a.why}`);
  if (r.commit) console.log(`pushed commit ${r.commit}`);
  if (!apply && r.outcome === 'planned') console.log('\nDRY RUN. Nothing was changed. Add --apply to push the repair commit.');
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
