#!/usr/bin/env node
// Runs the full content-repair pipeline (cap enforcement, marker-styling
// re-render, blog front-matter contract, placeholder removal) against a
// tenant's REAL repo via the GitHub API, and — if anything changed — QUEUES
// the computed, validated edits onto the shared shipping queue
// (store/shipping-queue.js, migration 148) rather than committing or opening
// a PR itself. The 07:00 auto-remediation run drains that queue into its own
// one build/one commit/one PR batch. This used to open its own separate PR
// directly; that was one of two autonomous producers bypassing the shared
// shipping pipeline (the other was learned-repair.js), which is why the
// daily ceiling and "one PR per day" could both be silently exceeded.
//
// WHY THIS EXISTS
//
// The four repairs this composes were each proven by hand against a local
// clone of zunkireelabs.com's repo (see each script's own module comment for
// what it fixes and why). They were manual, one-off tools. The defect class
// they fix — a shipped page whose styling doesn't match the site's own design
// — is not a one-time incident: it happens whenever a site's design profile
// gets a role wrong, and repair-design-profile-roles.js runs every morning
// specifically because that can recur. Running the CONTENT repair only once,
// by hand, would leave every future recurrence unrepaired until someone
// noticed and ran the scripts again manually. This is that same repair,
// wired into the same automated morning chain (see cron.js), against every
// site that has a repo connected — not just the one this was built for.
//
// NO LOCAL GIT CLONE. The production container has no `gh` CLI and no
// client build tooling (see repair-template-capability.js's own history note
// for why that path was abandoned there). Instead: fetch every file under
// `src/` via the GitHub REST client into a real temp directory, run the exact
// same fs-based repair scripts against that directory unchanged — they are
// already tested, and running them against a materialized checkout is
// indistinguishable from running them against a real clone — then diff the
// temp directory against what was fetched and commit only the files that
// actually changed.
//
// ORDER MATTERS, learned the hard way while building this by hand:
//   1. enforceVisibleFaqCap FIRST, on the UNRESTYLED files — if it ran after
//      marker-styling, every visible FAQ looks like the site's real
//      accordion and the wrong ones get demoted (this exact bug shipped once
//      during manual testing and was caught by diffing against expectation).
//   2. repairSiteMarkerStyling — re-renders marker regions + data-array
//      content through the site's CURRENT componentTemplates.
//   3. repairNewContentFrontmatter — blog directory only; front matter only.
//   4. stripPlaceholderContent LAST — operates on whatever markup is left
//      after restyling, so it never mistakes a class name for a placeholder.
//
//   node server/scripts/repair-site-content-live.js --site-id 1 [--dry-run]
//   import { repairSiteContentLive } from this file (job.js/cron.js)

import { mkdtemp, rm, mkdir, writeFile as fsWriteFile, readFile as fsReadFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getSiteById } from '../store/read.js';
import { getRepoTree, getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { enforceVisibleFaqCap } from './enforce-visible-faq-cap.js';
import { repairSiteMarkerStyling } from './repair-site-marker-styling.js';
import { repairNewContentFrontmatter } from './repair-newcontent-frontmatter.js';
import { stripPlaceholderContent } from './strip-placeholder-content.js';
import { fixCollectionSelfInclusion } from './fix-collection-self-inclusion.js';
import { enqueue as enqueueShippingWork, markPrepared as markShippingWorkPrepared } from '../store/shipping-queue.js';

// Everything these repairs touch lives under src/ — SEOAI markers, Eleventy
// data files, blog front matter. Materializing only this subtree (not the
// whole repo: node_modules-adjacent config, assets, etc.) keeps the fetch
// fast and avoids writing anything the repairs could not possibly change.
const PREFIX = 'src/';

/**
 * @param {number} siteId
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ siteId, changedFiles: string[], prCreated: {url,number,reused}|null, skipped?: string }}
 */
export async function repairSiteContentLive(siteId, { dryRun = false } = {}) {
  const report = { siteId, changedFiles: [], prCreated: null };

  const site = await getSiteById(siteId);
  if (!site?.repo_owner || !site?.repo_name) { report.skipped = 'no-repo'; return report; }

  const templates = site.url_file_map?.siteRoot?.componentTemplates;
  if (!templates) { report.skipped = 'no-component-templates'; return report; }

  const ref = baseBranch(site);
  const { files: repoFiles } = await getRepoTree(site, ref);
  const targets = repoFiles.filter((p) => p.startsWith(PREFIX));

  const tempDir = await mkdtemp(path.join(tmpdir(), `content-repair-site-${siteId}-`));
  const original = new Map(); // path -> content, for the final diff

  try {
    for (const relPath of targets) {
      const file = await getFileContent(site, relPath, ref);
      const content = typeof file === 'string' ? file : file?.content;
      if (content == null) continue;
      original.set(relPath, content);
      const abs = path.join(tempDir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await fsWriteFile(abs, content, 'utf8');
    }

    // Order matters — see the module comment above.
    if (site.visible_faq_cap != null) {
      await enforceVisibleFaqCap(tempDir, site.visible_faq_cap, templates.faq?.wrapper, { write: true });
    }
    await repairSiteMarkerStyling(tempDir, templates, { write: true });

    const blogDir = site.url_file_map?.newContentTargets?.['blog-outline']?.dir;
    if (blogDir) {
      await repairNewContentFrontmatter(tempDir, blogDir, { write: true });
      // A different bug class from everything above — a hand-written site
      // config issue (Eleventy's directory-data tag cascade), not agent
      // output — but it lives in the same directory this pipeline already
      // has open, costs one readdir to check, and is exactly the kind of
      // thing that stays broken forever if it depends on a human noticing.
      // See fix-collection-self-inclusion.js's own module comment.
      await fixCollectionSelfInclusion(tempDir, blogDir, { write: true });
    }

    await stripPlaceholderContent(tempDir, { write: true });

    // Diff every fetched file against what's now on disk in the temp dir.
    const edits = [];
    for (const [relPath, before] of original) {
      const after = await fsReadFile(path.join(tempDir, relPath), 'utf8').catch(() => null);
      if (after != null && after !== before) edits.push({ path: relPath, content: after });
    }

    report.changedFiles = edits.map((e) => e.path);
    if (!edits.length || dryRun) return report;

    // QUEUED, not committed here. This used to open its own
    // `content-repair/DATE` PR directly against GitHub — the exact
    // "no autonomous production generator may open its own PR" bypass the
    // shared shipping queue (migration 148, store/shipping-queue.js) exists
    // to close. The repair work above (fetch, diff, validate) IS the
    // preparation step — it is real, already-computed, already-validated
    // file content — so it goes straight to 'prepared' with the edits
    // carried in `params`, ready for the 07:00 shipping run to commit onto
    // whatever ONE shared batch branch that run creates and to include in
    // its ONE PR, alongside Analytics/Analyst/learned-repair work. No commit,
    // no branch, no PR happens in this function anymore.
    //
    // The commit message content (previously a hand-written PR body) is
    // preserved as `summary` in params, so the shipping run's own commit
    // message can still describe exactly what changed.
    const commitMessage = `Repair shipped content to match the site's own design (${edits.length} file(s))\n\n`
      + 'No text changed. Re-renders SEOAI-marker and data-array content through this site\'s current '
      + 'component templates, enforces visible_faq_cap, aligns generated blog front matter with its '
      + 'directory\'s own contract, and removes any section that still carries an unresolved citation '
      + 'or an invented competitor.\n\n'
      + `${edits.map((e) => `- ${e.path}`).join('\n')}\n\n`
      + 'See server/scripts/repair-site-content-live.js.';

    const { row } = await enqueueShippingWork(siteId, {
      source: 'content-repair', lane: 'analytics', kind: 'file-edits',
      params: { edits, commitMessage },
      // High, fixed priority: this is a correctness repair (shipped content
      // not matching the site's own design), not a growth optimization, and
      // small in volume (one run per site per day) — it should not have to
      // out-compete the analytics backlog's ordinary scoring to actually ship.
      score: 1_000_000,
    });
    if (row) {
      // Preparation (generation-equivalent) already succeeded above — mark
      // it 'prepared' immediately rather than waiting for a separate pass to
      // claim and redo work that is already done. A re-run of this repair
      // against a row already 'prepared'/'shipping' finds enqueue() a no-op
      // (the dedupe key is stable per site — see dedupeKeyFor's kind:'draft'
      // hash fallback) and markPrepared on an already-'shipping' row is
      // guarded by its own WHERE state <> 'shipped' clause, so a duplicate
      // cron firing can never double-queue or clobber an in-flight batch.
      const prepared = await markShippingWorkPrepared(row.id, { filePaths: edits.map((e) => e.path), score: 1_000_000 });
      report.queued = { id: row.id, state: prepared?.state || row.state };
    }
    return report;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// CLI entrypoint only — importing this module must never parse argv or exit.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
  };
  const siteId = Number(arg('site-id'));
  const dryRun = process.argv.includes('--dry-run');
  if (!siteId) {
    console.error('Usage: repair-site-content-live.js --site-id <id> [--dry-run]');
    process.exit(1);
  }
  const report = await repairSiteContentLive(siteId, { dryRun });
  console.log(JSON.stringify(report, null, 2));
}
