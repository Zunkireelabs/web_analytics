#!/usr/bin/env node
// Queues a fresh component-template derivation for 'expand-content' on
// already-onboarded sites, so a site whose template was persisted BEFORE
// compose-expand-layout.js existed gets a chance to pick up the new
// generated layout — resolveOrCreateComponentTemplate's own fast path
// (design-drift.js) returns an already-verified template unchanged and never
// re-derives on its own, so a site with a long-standing plain projected
// expand-content template would otherwise keep it forever.
//
// This does NOT write anything to a site's templates directly. It only
// enqueues the exact same 'design_generate' / mode:'component-templates' job
// resolveOrCreateComponentTemplate itself creates on a cache miss — the
// worker (worker.js -> live-analysis-handler.js) does the real work,
// generates+validates a candidate, and persistDerivedComponentTemplates
// (design-drift.js) is what actually overwrites
// componentTemplates.expandContent, exactly as it does for any other
// derivation. Nothing here bypasses that verification.
//
// A site with no usable design profile, no Tailwind styling, or an
// unreachable live page simply keeps its current template — the worker's
// existing fail-open behavior (see compose-expand-layout.js and
// live-analysis-handler.js), not a failure of this script.
//
//   node server/scripts/regenerate-expand-layout.js --site 1
//   node server/scripts/regenerate-expand-layout.js --all
//   node server/scripts/regenerate-expand-layout.js --all --commit
//
// (--commit actually enqueues; without it this only lists which sites would
// be queued, since a design_generate job costs a live-site Playwright
// capture plus a model call and should never fire from a bare invocation.)
import 'dotenv/config';
import { query } from '../db.js';
import { createComponentTemplateJob, getQueuedComponentTemplateJob } from '../store/execution-jobs.js';
import { sitePageUrl } from '../implementers/lib/design-drift.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

export async function queueExpandLayoutRegeneration(sites, { commit = false } = {}) {
  let queued = 0;
  let skipped = 0;
  const results = [];
  for (const site of sites) {
    const pageUrl = sitePageUrl(site);
    if (!pageUrl) {
      console.log(`  ✗ ${site.name} (site ${site.id}) — no site URL on record, cannot capture a live page.`);
      skipped++;
      results.push({ siteId: site.id, ok: false, reason: 'no-url' });
      continue;
    }

    const alreadyQueued = await getQueuedComponentTemplateJob(site.id, 'expand-content');
    if (alreadyQueued) {
      console.log(`  · ${site.name} (site ${site.id}) — already has a pending derivation job (#${alreadyQueued.id}), skipping.`);
      skipped++;
      results.push({ siteId: site.id, ok: false, reason: 'already-queued' });
      continue;
    }

    if (!commit) {
      console.log(`  would queue: ${site.name} (site ${site.id}) — ${pageUrl}`);
      queued++;
      results.push({ siteId: site.id, ok: true, dryRun: true });
      continue;
    }

    const job = await createComponentTemplateJob(site.id, ['expand-content'], { pageUrl });
    console.log(`  ✓ ${site.name} (site ${site.id}) — queued job #${job.id}`);
    queued++;
    results.push({ siteId: site.id, ok: true, jobId: job.id });
  }
  return { examined: sites.length, queued, skipped, results };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const siteId = Number(arg('site'));
  const all = process.argv.includes('--all');
  const commit = process.argv.includes('--commit');

  if (!siteId && !all) {
    console.error('Usage: regenerate-expand-layout.js (--site <id> | --all) [--commit]');
    process.exit(1);
  }

  // Only sites with a stored design profile can produce anything — a site
  // with none would just have its job queue a design-profile derivation
  // first anyway (createComponentTemplateJob doesn't do that; it's the
  // resolveOrCreateComponentTemplate path that does), so this script scopes
  // to sites already past that step.
  const { rows: sites } = all
    ? await query(`select * from sites
         where url_file_map->'siteRoot'->'designProfile' is not null
         order by id`)
    : await query('select * from sites where id = $1', [siteId]);

  if (!sites.length) {
    console.error(all ? 'No site has a stored design profile.' : `No site ${siteId}.`);
    process.exit(1);
  }

  const { examined, queued, skipped } = await queueExpandLayoutRegeneration(sites, { commit });
  console.log(`\n${examined} site(s) examined, ${queued} queued, ${skipped} skipped.`);
  if (!commit) console.log('Dry run — re-run with --commit to actually enqueue derivation jobs.');
  process.exit(0);
}
