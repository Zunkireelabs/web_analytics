import { getSiteById } from '../store/read.js';
import { getFileContent, defaultBranchName } from '../github/client.js';
import { searchImage, buildImageQueries, configured as imagesConfigured } from './lib/pexels-client.js';
import { extractTitle, hasImageField } from './lib/blog-frontmatter.js';
import { usedPhotoIds } from './lib/blog-image-usage.js';

// The repair half of agents/blog-image.js's detection: re-fetches the ONE
// post the detector already identified (by its real repo path, not a
// re-derived URL) and re-derives everything live rather than trusting
// anything the detector cached — same discipline every other safe-tier
// generator here follows, and the reason a post that picked up an image
// (or lost its title) between detection and generation refuses rather than
// silently doing something stale.
//
// Uses the exact same relevance-scored Pexels search new posts already get
// (pexels-client.js's searchImage + buildImageQueries) — never the first
// result, and never a forced match: a post with no good candidate gets no
// image, same honest-absence rule blog-outline.js itself follows.
export const meta = {
  id: 'blog-image',
  name: 'Blog Featured Image',
  description: 'Adds a featured image to an existing blog post published with none, matched by relevance to the post\'s own real title.',
  recommendationTags: [],
};

// params: { filePath: string } — the exact repo path agents/blog-image.js's
// detection pass already found; no page URL involved.
export async function generate({ siteId, params }) {
  const { filePath } = params || {};
  if (!filePath) throw Object.assign(new Error('filePath is required'), { status: 400 });

  // Same gate every image-fetching path in this platform respects — refuses
  // rather than drafting something that can never actually apply.
  if (!imagesConfigured()) {
    throw Object.assign(new Error('Image search is not configured for this platform.'), { status: 400, userFacing: true });
  }

  const site = await getSiteById(siteId);
  const ref = defaultBranchName(site);
  const file = await getFileContent(site, filePath, ref);
  const raw = typeof file === 'string' ? file : file?.content;
  if (!raw) throw Object.assign(new Error(`Could not read ${filePath} from the repo.`), { status: 400 });

  if (hasImageField(raw)) {
    throw Object.assign(
      new Error(`${filePath} already has a featured image — this recommendation is stale.`),
      { status: 400, userFacing: true },
    );
  }

  const title = extractTitle(raw);
  if (!title) {
    throw Object.assign(
      new Error(`Could not find a real title in ${filePath}'s front matter.`),
      { status: 400, userFacing: true },
    );
  }

  const excludePhotoIds = await usedPhotoIds(site);
  const image = await searchImage(buildImageQueries({ title }), { excludePhotoIds });
  if (!image) {
    throw Object.assign(
      new Error(`No relevant real image was found for "${title}" — a wrong photo is worse than none, so this is left for manual review rather than forcing a weak match.`),
      { status: 400, userFacing: true },
    );
  }

  return {
    content: {
      filePath,
      title,
      imageUrl: image.url,
      imageAlt: image.alt || title,
      imageCredit: image.photographer ? `Photo by ${image.photographer} on Pexels` : null,
    },
    summary: `Add a featured image to "${title}"`,
  };
}
