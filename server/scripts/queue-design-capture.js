import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { siteHasUsableDesignProfile } from '../implementers/lib/design-drift.js';
import { getQueuedComponentTemplateJob, getLatestDesignAgentJob, DESIGN_PROFILE_JOB_KEY } from '../store/execution-jobs.js';
import { queueDesignAgentDerivationForSite } from '../job.js';

// Queues a Design Agent capture (the read of a site's design that shipping waits for) for the projects that have none, and says plainly why
// when it does not. Capture needs the OpenAI project to be under its spend limit.
//
//   node server/scripts/queue-design-capture.js --site-id 8871 --site-id 8874            CHECK: prints what it would do
//   node server/scripts/queue-design-capture.js --site-id 8871 --site-id 8874 --yes      queues the captures (adds one job row each)
//
// A project is queued only when it has a repository, no usable design profile, and no capture already waiting: the same rule the daily
// 06:00 sweep uses (job.js queueDesignAgentDerivationForSite), which is what this calls.

const argv = process.argv;
const ids = argv.flatMap((a, i) => (a === '--site-id' ? [Number(argv[i + 1])] : [])).filter(Boolean);
const write = argv.includes('--yes');

async function main() {
  if (!ids.length) { console.error('Usage: node server/scripts/queue-design-capture.js --site-id <id> [--site-id <id> ...] [--yes]'); process.exit(1); }
  for (const id of ids) {
    const site = await getSiteById(id);
    if (!site) { console.log(`site ${id}: not found`); continue; }
    const last = await getLatestDesignAgentJob(id, DESIGN_PROFILE_JOB_KEY).catch(() => null);
    const lastTxt = last ? `last capture job #${last.id} ${last.status}` : 'no capture job yet';
    if (!site.repo_owner || !site.repo_name) { console.log(`site ${id} "${site.name}": NOT queued: no repository connected (${lastTxt})`); continue; }
    if (siteHasUsableDesignProfile(site)) { console.log(`site ${id} "${site.name}": NOT queued: already has a usable design profile (${lastTxt})`); continue; }
    const pending = await getQueuedComponentTemplateJob(id, DESIGN_PROFILE_JOB_KEY);
    if (pending) { console.log(`site ${id} "${site.name}": NOT queued: a capture is already waiting (job #${pending.id})`); continue; }
    if (!write) { console.log(`site ${id} "${site.name}": WOULD queue a capture (${lastTxt})`); continue; }
    const queued = await queueDesignAgentDerivationForSite(site);
    console.log(`site ${id} "${site.name}": ${queued ? 'QUEUED' : 'not queued (the queue call declined)'} (${lastTxt})`);
  }
  if (!write) console.log('\nCHECK ONLY. Nothing was queued. Add --yes to queue.');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
