#!/usr/bin/env node
// Runs the full content-repair pipeline (cap enforcement, marker-styling
// re-render, blog front-matter contract, placeholder removal) against a
// tenant's REAL repo via the GitHub API, and opens one PR if anything changed.
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
import {
  getRepoTree, getFileContent, getBranchSha, createBranch, commitFilesAtomic,
  openPullRequest, defaultBranchName, listOpenPullRequestsForBranch,
} from '../github/client.js';
import { enforceVisibleFaqCap } from './enforce-visible-faq-cap.js';
import { repairSiteMarkerStyling } from './repair-site-marker-styling.js';
import { repairNewContentFrontmatter } from './repair-newcontent-frontmatter.js';
import { stripPlaceholderContent } from './strip-placeholder-content.js';
import { fixCollectionSelfInclusion } from './fix-collection-self-inclusion.js';

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

  const ref = defaultBranchName(site);
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

    const branchName = `content-repair/${new Date().toISOString().slice(0, 10)}`;
    const fromSha = await getBranchSha(site, ref);
    await createBranch(site, branchName, fromSha);
    await commitFilesAtomic(site, branchName, edits,
      `Repair shipped content to match the site's own design (${edits.length} file(s))\n\n`
      + 'No text changed. Re-renders SEOAI-marker and data-array content through this site\'s current '
      + 'component templates, enforces visible_faq_cap, aligns generated blog front matter with its '
      + 'directory\'s own contract, and removes any section that still carries an unresolved citation '
      + 'or an invented competitor. See server/scripts/repair-site-content-live.js.');

    const existingPrs = await listOpenPullRequestsForBranch(site, branchName);
    const pr = existingPrs.length
      ? { url: existingPrs[0].html_url, number: existingPrs[0].number }
      : await openPullRequest(site, {
        branch: branchName,
        title: `Repair ${edits.length} file(s) to match the site's own design`,
        body: `Automated daily repair — re-checks every SEOAI-marker region and generated blog post against `
          + `this site's own current design (component templates, visible-FAQ cap, blog front-matter contract, `
          + `directory-collection self-inclusion, and placeholder/fabricated-competitor content), and fixes `
          + `anything that has drifted.\n\n`
          + `No post/page TEXT is changed by this pipeline — only markup, front matter, and (for placeholder `
          + `content specifically) removal of sections that were never honestly fillable.\n\n`
          + `${edits.map((e) => `- \`${e.path}\``).join('\n')}\n\n**This PR does not merge itself.**`,
      });
    report.prCreated = { url: pr.url, number: pr.number, reused: existingPrs.length > 0 };
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
