import { getSiteById } from '../store/read.js';
import { getRepoTree, getFileContent, defaultBranchName } from '../github/client.js';
import { configured as imagesConfigured } from '../generators/lib/pexels-client.js';
import { extractTitle, hasImageField, listPostPaths } from '../generators/lib/blog-frontmatter.js';
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
  description: 'Finds existing blog posts published with no featured image at all — before Pexels search was wired into new-post drafting, or from a run where it came back empty.',
  category: 'content',
  version: 1,
};

// Real repo-tree scan for this site's blog directory, filtered to actual
// posts (skips directory data files, the directory index, and anything
// with the wrong extension — same rules the original script used), then
// each candidate's real front matter is read to confirm it genuinely has no
// image field under any alias and genuinely has a real title to search
// against. No Pexels call here — see this file's own top comment.
async function defaultFindPostsWithoutImage(site, target) {
  const ref = defaultBranchName(site);
  const { files } = await getRepoTree(site, ref);
  const paths = listPostPaths(files, target);

  const out = [];
  for (const filePath of paths) {
    // eslint-disable-next-line no-await-in-loop
    const file = await getFileContent(site, filePath, ref);
    const raw = typeof file === 'string' ? file : file?.content;
    if (!raw || hasImageField(raw)) continue;
    const title = extractTitle(raw);
    if (!title) continue;
    out.push({ filePath, title });
  }
  return out;
}

export async function run({ siteId, findPostsWithoutImage = defaultFindPostsWithoutImage } = {}) {
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

  const posts = await findPostsWithoutImage(site, target);

  // recommendationPageKey special-cases 'blog-image' to key on filePath
  // directly (recommendation-coordinator.js) — there is no live URL derived
  // here to key on, and the exact repo path is already unambiguous ground
  // truth, not something worth re-deriving from a title/slug guess.
  const findings = posts.map(({ filePath, title }) => makeFinding({
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

  const facts = { checkedPosts: posts.length, findings };
  const narrative = findings.length
    ? `${findings.length} blog post(s) have no featured image at all.`
    : 'Every checked blog post already has a featured image.';

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
