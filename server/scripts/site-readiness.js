import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { runSiteReadiness, summarizeReadiness } from '../readiness/run.js';
import { saveReadinessResult } from '../store/readiness.js';

// Is this project READY for the daily agent? The same pass the setup-PR job runs for every new client, for any stack:
//   learn the stack -> complete the page list -> map every page to its files -> plan the markers -> the completeness gate -> design capture
//
//   node server/scripts/site-readiness.js --site-id 8874            CHECK ONLY: reads the repository and prints the report, changes nothing
//   node server/scripts/site-readiness.js --site-id 8874 --apply    also re-discovers the page list, SAVES the inferred mapping (read back through the
//                                                                    daily run's resolver; the old mapping is restored on any difference), queues the
//                                                                    design capture if the project has none, and stores the result
//
// Opening or rebuilding the setup PR is a separate step (refresh-setup-pr.js). Exit code 0 only when every page and marker is placed or stated, and the design is usable.

const argv = process.argv;
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };
const line = (s = '') => console.log(s);

async function main() {
  const siteId = Number(flag('site-id')); const apply = flag('apply') === true;
  if (!siteId) { console.error('Usage: node server/scripts/site-readiness.js --site-id <id> [--apply]'); process.exit(1); }
  const site = await getSiteById(siteId);
  if (!site) { console.error(`Site ${siteId} not found.`); process.exit(1); }

  const r = await runSiteReadiness(site, { apply });
  line(`\n=== Site ${siteId} "${site.name}"  ${apply ? 'APPLY' : 'CHECK ONLY'}`);
  if (r.reason) { line(`NOT READY: ${r.reason}`); process.exit(2); }
  line(`stack: ${r.stack || 'not identified'}   pages: ${r.steps.pages.count}${r.steps.pages.excluded ? ` (+${r.steps.pages.excluded} non-HTML files left out)` : ''}`);
  line(`\n1-3  MAPPING ${r.steps.mapping.saved ? '(saved and read back)' : r.steps.mapping.changed ? '(would change; not saved)' : '(nothing to change)'}`);
  for (const n of r.steps.mapping.notes) line(`  - ${n}`);
  if (r.steps.mapping.rolledBack) line(`  ROLLED BACK: ${r.steps.mapping.rolledBack.count} page(s) did not resolve as planned after saving (e.g. ${r.steps.mapping.rolledBack.example})`);
  line(`  unmapped pages: ${r.steps.mapping.unmapped.length}`);
  for (const u of r.steps.mapping.unmapped.slice(0, 8)) line(`    ${new URL(u.page).pathname}  ${u.reason}`);
  if (r.steps.mapping.unmapped.length > 8) line(`    ... and ${r.steps.mapping.unmapped.length - 8} more`);

  line(`\n4    MARKERS  the setup PR would change ${r.steps.plan.files} files and place ${r.steps.plan.markers} markers (${r.gate.placed} placed in total)${r.steps.plan.truncated ? ' (capped)' : ''}`);
  line(`\n5    COMPLETENESS GATE: ${r.gate.markersComplete ? 'COMPLETE' : 'NOT COMPLETE'}`);
  for (const g of r.gate.openGaps) line(`  OPEN   ${g.marker}: ${g.reason}  (${g.pages} pages, e.g. ${g.examples.map((e) => new URL(e).pathname).join(', ')})`);
  for (const g of r.gate.notApplicable) line(`  stated ${g.marker}: ${g.reason}  (${g.pages} pages)`);
  if (!r.gate.openGaps.length && !r.steps.mapping.unmapped.length) line('  nothing is missing');

  line(`\n6    DESIGN CAPTURE: ${r.design.state}${r.design.queuedNow ? ' (queued now)' : ''}${r.design.lastJob ? ` (last job #${r.design.lastJob.id} ${r.design.lastJob.status})` : ''}`);
  line(`\nREADY: ${r.ready ? 'yes' : 'no'}`);
  if (apply) { await saveReadinessResult(siteId, summarizeReadiness(r)); line('result stored on the project'); }
  else line('\nCHECK ONLY. Nothing was changed. Add --apply to save the mapping and queue the design capture.');
  process.exit(r.ready ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
