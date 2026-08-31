#!/usr/bin/env node
// Adds a featured image to a tenant's existing blog posts that were published
// with none — 17 of 48 on zunkireelabs.com, all written before blog-outline.js
// wired image search in at all (or from a run where Pexels came back empty).
//
// WHY A SEPARATE PASS, NOT PART OF THE DRAFT PIPELINE
//
// blog-outline.js only ever runs once per post, at creation. A post already
// published has no draft to regenerate — its front matter has to be edited in
// place, in the real repo, which is exactly what repair-newpage-frontmatter.js
// (a plain rewrite) does NOT do, since it only touches contract keys already
// present. This is additive: it never rewrites a key that exists, only adds
// featuredImage/featuredImageAlt/featuredImageCredit where the whole field is
// absent. A post that already has an image, however it got it, is left alone.
//
// Uses the exact same search this platform now uses for new posts
// (pexels-client.js's searchImage + buildImageQueries) — scored for relevance
// against the post's own real title, never the first Pexels result.
// A post with no good match gets no image, same as a new draft would: absence
// is honest, a wrong photo is not.
//
// Runs as part of the SAME 07:00 daily chain as every other repair pass here
// (see cron.js), not on demand — every site is checked every morning, and a
// site with nothing to backfill costs one cheap repo-tree read.
//
//   node server/scripts/backfill-blog-images.js --site-id 1 [--dry-run]
//   import { backfillBlogImagesForSite } from this file (job.js/cron.js)

import { getSiteById } from '../store/read.js';
import {
  getRepoTree, getFileContent, getBranchSha, createBranch, commitFilesAtomic,
  openPullRequest, defaultBranchName, listOpenPullRequestsForBranch,
} from '../github/client.js';
import { searchImage, buildImageQueries, configured as imagesConfigured } from '../generators/lib/pexels-client.js';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function frontMatterKeys(raw) {
  const m = FRONT_MATTER.exec(raw || '');
  if (!m) return new Set();
  return new Set(
    m[1].split('\n')
      .filter((l) => !/^\s/.test(l))
      .map((l) => /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(l)?.[1])
      .filter(Boolean),
  );
}

function extractTitle(raw) {
  const m = FRONT_MATTER.exec(raw || '');
  if (!m) return null;
  const t = /^title\s*:\s*"?(.*?)"?\s*$/m.exec(m[1]);
  return t ? t[1].trim() : null;
}

function escapeYaml(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Inserts fields right after the closing `title`/`description` block if
// present, else right before the closing `---` — position doesn't matter to
// any parser here, but keeping new fields near the top instead of always last
// keeps the diff readable next to how newpage-render.js already orders them.
function insertFrontMatterFields(raw, fields) {
  const lines = fields
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: "${escapeYaml(v)}"`);
  if (!lines.length) return raw;
  return raw.replace(FRONT_MATTER, (whole, body) => `---\n${body}\n${lines.join('\n')}\n---`);
}

/**
 * @param {number} siteId
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ siteId, checked: number, imaged: number, noMatch: number, filesChanged: string[], prCreated: {url,number,reused}|null }}
 */
export async function backfillBlogImagesForSite(siteId, { dryRun = false } = {}) {
  const report = { siteId, checked: 0, imaged: 0, noMatch: 0, filesChanged: [], prCreated: null };
  if (!imagesConfigured()) return report; // same gate every image-fetching path respects

  const site = await getSiteById(siteId);
  if (!site?.repo_owner || !site?.repo_name) return report;

  const target = site.url_file_map?.newContentTargets?.['blog-outline'];
  if (!target?.dir) return report; // no known blog directory — nothing to scan

  const ref = defaultBranchName(site);
  const { files } = await getRepoTree(site, ref);
  const prefix = target.dir.endsWith('/') ? target.dir : `${target.dir}/`;
  const posts = files.filter((p) => p.startsWith(prefix) && p.endsWith(target.extension || '.md')
    && !p.slice(prefix.length).includes('/') && !p.split('/').pop().startsWith('_') && !/^index\./i.test(p.split('/').pop()));

  const edits = [];
  for (const path of posts) {
    const file = await getFileContent(site, path, ref);
    const raw = typeof file === 'string' ? file : file?.content;
    if (!raw) continue;

    const keys = frontMatterKeys(raw);
    // Same alias set newcontent-contract.js checks — a post whose image lives
    // under any of these already has one; only a post with NONE of them is missing.
    if (['featuredImage', 'image', 'heroImage', 'cover', 'thumbnail'].some((k) => keys.has(k))) continue;

    report.checked++;
    const title = extractTitle(raw);
    if (!title) continue;

    const image = await searchImage(buildImageQueries({ title }));
    if (!image) { report.noMatch++; continue; }

    report.imaged++;
    const updated = insertFrontMatterFields(raw, [
      ['featuredImage', image.url],
      ['featuredImageAlt', image.alt || title],
      ['featuredImageCredit', image.photographer ? `Photo by ${image.photographer} on Pexels` : null],
    ]);
    edits.push({ path, content: updated });
  }

  if (!edits.length || dryRun) return report;

  const branchName = `image-backfill/${new Date().toISOString().slice(0, 10)}`;
  const fromSha = await getBranchSha(site, ref);
  await createBranch(site, branchName, fromSha);
  await commitFilesAtomic(site, branchName, edits,
    `Backfill featured images for ${edits.length} existing blog post(s)\n\n`
    + 'Added featuredImage/featuredImageAlt to posts published with none. No text changed. '
    + `Images matched by relevance to each post's own title — see server/generators/lib/pexels-client.js.`);

  const existingPrs = await listOpenPullRequestsForBranch(site, branchName);
  const pr = existingPrs.length
    ? { url: existingPrs[0].html_url, number: existingPrs[0].number }
    : await openPullRequest(site, {
      branch: branchName,
      title: `Backfill featured images for ${edits.length} blog post(s)`,
      body: `${edits.length} post(s) in \`${target.dir}\` had no featured image at all — published before image search was wired in, `
        + `or from a run where the search came back empty. Each was re-searched using the same relevance-scored Pexels lookup `
        + `new posts now use, against that post's own real title. A post with no good match got no image, same as a new draft would.\n\n`
        + `No post text changed — front matter only.\n\n${edits.map((e) => `- \`${e.path}\``).join('\n')}\n\n`
        + '**This PR does not merge itself.**',
    });
  report.prCreated = { url: pr.url, number: pr.number, reused: existingPrs.length > 0 };
  report.filesChanged = edits.map((e) => e.path);
  return report;
}
