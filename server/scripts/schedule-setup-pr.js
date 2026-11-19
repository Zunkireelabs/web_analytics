import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { scheduleSetupPr, clearSetupPrSchedule } from '../store/setup-pr.js';

// Schedules the setup PR for existing projects, staggered, so they open one by one. The scheduled job (every ten minutes) does the rest.
//
//   node server/scripts/schedule-setup-pr.js --site-id 8874 --site-id 8872 --site-id 8871 --start-in 60 --every 60
//        prints the times it WOULD set: nothing is written
//   ... add --yes                      writes them (this changes production data: three timestamps)
//   node server/scripts/schedule-setup-pr.js --site-id 8874 --clear --yes      cancels a schedule that has not run yet
//
// The order given is the order they run in. A project that already has its setup PR done is refused by the store and shown as such.

const multi = (name) => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]] : []));
const num = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? d : Number(process.argv[i + 1]); };

async function main() {
  const ids = multi('site-id').map(Number).filter(Boolean);
  if (!ids.length) { console.error('Usage: node server/scripts/schedule-setup-pr.js --site-id <id> [--site-id <id> ...] [--start-in 60] [--every 60] [--yes] [--clear]'); process.exit(1); }
  const write = process.argv.includes('--yes');
  const clear = process.argv.includes('--clear');
  const startIn = num('start-in', 60); const every = num('every', 60);

  let n = 0;
  for (const id of ids) {
    const site = await getSiteById(id);
    if (!site) { console.log(`site ${id}: not found`); continue; }
    if (clear) {
      console.log(`site ${id} "${site.name}": ${write ? ((await clearSetupPrSchedule(id)) ? 'schedule cleared' : 'nothing to clear (already done or never scheduled)') : 'would clear the schedule'}`);
      continue;
    }
    const due = new Date(Date.now() + (startIn + n * every) * 60000);
    if (site.setup_pr_done_at) { console.log(`site ${id} "${site.name}": setup PR already done ${new Date(site.setup_pr_done_at).toISOString()}, not scheduled`); continue; }
    if (write) {
      const set = await scheduleSetupPr(id, due);
      console.log(`site ${id} "${site.name}": scheduled for ${new Date(set).toISOString()}`);
    } else {
      console.log(`site ${id} "${site.name}": WOULD schedule for ${due.toISOString()}  (repo ${site.repo_owner ? 'connected' : 'NOT connected'}, Auto-fixes ${site.auto_remediation_enabled ? 'on' : 'OFF'}, baseline ${site.onboarded_at ? 'done' : 'NOT done'})`);
    }
    n++;
  }
  if (!write) console.log('\nNothing was written. Add --yes to apply.');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
