import { getSiteById } from '../store/read.js';
import { getRepoTree, getFileContent, defaultBranchName } from '../github/client.js';
import { configured as imagesConfigured, pexelsPhotoIdFromUrl } from '../generators/lib/pexels-client.js';
import {
  extractTitle, extractImageUrl, hasImageField, listPostPaths,
} from '../generators/lib/blog-frontmatter.js';
import { makeFinding } from './lib/findings.js';
import { effortForGenerator } from './lib/page-content.js';

// Detection half of the blog-image pipeline — was previously fused with
// repair AND with shipping into one script (server/scripts/backfill-blog-
// images.js) that read the whole repo tree and opened its own PR directly,
// with no Action Center recommendation, no draft, no review step at all.
// Split the same way content-integrity.js/content-integrity-repair.js
// already are: this agent only decides WHICH posts qualify (a real repo
// scan, cheap — one tree read plus one content fetch per candidate post, no
// external API calls), never what image to use — that real Pexels search,
// with its network cost, only happens in generators/blog-image.js, and only
// for a post someone (human or the autonomous shipping loop) actually
// decided to draft.
export const meta = {
  id: 'blog-image',
  name: 'Blog Image Agent',
  description: 'Finds existing blog posts published with no featured image at all, sharing their featured image with another post, or pointing at a local asset file that was never actually committed.',
  category: 'content',
  version: 1,
};

// A local asset reference ("/assets/images/blog/x.jpg", not a real URL) is
// only trustworthy if that exact file is really in the repo tree — a real,
// confirmed report: several posts (e.g. the 2026-03-30/04-03 batch) carry a
// featuredImage value that LOOKS like a real field (hasImageField reads
// true) but names a file that was never committed, so the live site renders
// nothing. `files` is the same full tree this function already fetched for
// listPostPaths — no extra network call.
function localAssetExists(url, files) {
  if (!url || /^https?:\/\//i.test(url)) return true; // remote URL: can't verify without a network call, so don't flag it
  const trimmed = url.replace(/^\//, '');
  return files.some((f) => f === trimmed || f.endsWith(`/${trimmed}`));
}

// Real repo-tree scan for this site's blog directory, filtered to actual
// posts (skips directory data files, the directory index, and anything
// with the wrong extension — same rules the original script used), then
// each candidate's real front matter is read to classify it as missing an
// image entirely, pointing at a local asset that doesn't exist, or carrying
// a real Pexels photo id that a LATER post (by file path) also carries —
// the actual shape the 2026-09-01 convergence bug (pexels-client.js's old
// query-pooling) left behind: dozens of posts each individually "have an
// image", just the same one. A remote URL that isn't a recognized Pexels
// photo id is left alone — nothing here can safely judge that a duplicate.
// No Pexels call here — see this file's own top comment.
async function defaultFindPostsNeedingImage(site, target) {
  const ref = defaultBranchName(site);
  const { files } = await getRepoTree(site, ref);
  const paths = listPostPaths(files, target);

  const missing = [];
  const broken = [];
  const withImage = []; // { filePath, title, photoId }
  for (const filePath of paths) {
    // eslint-disable-next-line no-await-in-loop
    const file = await getFileContent(site, filePath, ref);
    const raw = typeof file === 'string' ? file : file?.content;
    if (!raw) continue;
    const title = extractTitle(raw);
    if (!title) continue;
    if (!hasImageField(raw)) { missing.push({ filePath, title }); continue; }
    const url = extractImageUrl(raw);
    if (!localAssetExists(url, files)) { broken.push({ filePath, title }); continue; }
    const photoId = pexelsPhotoIdFromUrl(url);
    if (photoId != null) withImage.push({ filePath, title, photoId });
  }

  // Group by photo id; the first post (stable file-path order) keeps it, any
  // later post sharing it is flagged — same "one keeper, repair the rest"
  // rule a human doing this by hand would apply.
  const byPhotoId = new Map();
  for (const post of withImage) {
    if (!byPhotoId.has(post.photoId)) byPhotoId.set(post.photoId, []);
    byPhotoId.get(post.photoId).push(post);
  }
  const duplicates = [...byPhotoId.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => group.slice(1));

  return { missing, duplicates, broken };
}

export async function run({ siteId, findPostsNeedingImage = defaultFindPostsNeedingImage } = {}) {
  // Gated the same way the generator itself is — a finding this platform can
  // never safely turn into a real fix (no image search configured at all)
  // is worse than no finding: it would sit open in the Action Center
  // forever with no honest path to resolution.
  if (!imagesConfigured()) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'Image search is not configured for this platform.',
      generatedAt: new Date().toISOString(),
    };
  }

  const site = await getSiteById(siteId);
  if (!site?.repo_owner || !site?.repo_name) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No GitHub repository connected — nothing to scan.',
      generatedAt: new Date().toISOString(),
    };
  }

  const target = site.url_file_map?.newContentTargets?.['blog-outline'];
  if (!target?.dir) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No blog directory configured (url_file_map.newContentTargets["blog-outline"]) — nothing to scan.',
      generatedAt: new Date().toISOString(),
    };
  }

  const { missing, duplicates, broken } = await findPostsNeedingImage(site, target);

  // recommendationPageKey special-cases 'blog-image' to key on filePath
  // directly (recommendation-coordinator.js) — there is no live URL derived
  // here to key on, and the exact repo path is already unambiguous ground
  // truth, not something worth re-deriving from a title/slug guess.
  const missingFindings = missing.map(({ filePath, title }) => makeFinding({
    id: `blog-image:${filePath}`,
    evidence: { filePath, title },
    whyItMatters: `"${title}" has no featured image at all — published before image search was wired in, or from a run where the search came back empty.`,
    priority: 'low',
    recommendedAction: {
      label: 'Add a featured image',
      generatorId: 'blog-image',
      params: { filePath },
      effort: effortForGenerator('blog-image'),
    },
    expectedImpact: { label: 'Low', basis: 'computed', value: 1 },
  }));
  const duplicateFindings = duplicates.map(({ filePath, title, photoId }) => makeFinding({
    id: `blog-image:${filePath}`,
    evidence: { filePath, title, photoId },
    whyItMatters: `"${title}" shares its featured image with another post on the site — from before duplicate photos were excluded, this is one of the repeats.`,
    priority: 'low',
    recommendedAction: {
      label: 'Replace the duplicate featured image',
      generatorId: 'blog-image',
      params: { filePath, mode: 'duplicate' },
      effort: effortForGenerator('blog-image'),
    },
    expectedImpact: { label: 'Low', basis: 'computed', value: 1 },
  }));
  const brokenFindings = broken.map(({ filePath, title }) => makeFinding({
    id: `blog-image:${filePath}`,
    evidence: { filePath, title },
    whyItMatters: `"${title}"'s featured image points at a local file that was never actually committed to the repo — the post looks like it has an image, but nothing renders on the live site.`,
    priority: 'low',
    recommendedAction: {
      label: 'Fix the broken featured image link',
      generatorId: 'blog-image',
      params: { filePath, mode: 'broken' },
      effort: effortForGenerator('blog-image'),
    },
    expectedImpact: { label: 'Low', basis: 'computed', value: 1 },
  }));
  const findings = [...missingFindings, ...duplicateFindings, ...brokenFindings];

  const facts = { checkedPosts: missing.length + duplicates.length + broken.length, findings };
  const narrative = findings.length
    ? `${missingFindings.length} blog post(s) have no featured image at all, ${duplicateFindings.length} share their image with another post, ${brokenFindings.length} point at an image that was never committed.`
    : 'Every checked blog post already has a real, unique featured image.';

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
