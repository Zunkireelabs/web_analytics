import { getSiteById } from '../store/read.js';
import { getFileContent, defaultBranchName } from '../github/client.js';
import { searchImage, buildImageQueries, configured as imagesConfigured } from './lib/pexels-client.js';
import { extractTitle, hasImageField } from './lib/blog-frontmatter.js';
import { usedPhotoIds } from './lib/blog-image-usage.js';
import { imageQueryContextFor, IMAGE_CANDIDATE_POOL } from './lib/blog-image-query.js';

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
  description: 'Adds a featured image to an existing blog post published with none, or replaces one that duplicates another post\'s image or points at a file that was never committed — matched by relevance to the post\'s own real title.',
  recommendationTags: [],
};

// params: { filePath: string, mode?: 'missing' | 'duplicate' | 'broken' } —
// the exact repo path agents/blog-image.js's detection pass already found;
// no page URL involved. 'missing' (the default, for old recommendations
// with no mode field) requires no image field at all, same as this
// generator's original behavior; 'duplicate'/'broken' both require the
// opposite — a real image field already present — since either is replacing
// one, not adding one; they differ only in the detector's reason and the
// summary text below, not in what this generator does.
export async function generate({ siteId, params }) {
  const { filePath, mode = 'missing' } = params || {};
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

  const hasImage = hasImageField(raw);
  if (mode === 'missing' && hasImage) {
    throw Object.assign(
      new Error(`${filePath} already has a featured image — this recommendation is stale.`),
      { status: 400, userFacing: true },
    );
  }
  if (mode !== 'missing' && !hasImage) {
    throw Object.assign(
      new Error(`${filePath} no longer has a featured image to replace — this recommendation is stale.`),
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

  // Excludes every photo id already in use on the site, INCLUDING this
  // post's own current one when mode is 'duplicate' — the whole point of a
  // duplicate/broken repair is landing on a different, real photo, not
  // re-confirming the same one (or, for 'broken', it has no photo id to
  // exclude at all, so this is a no-op there).
  const excludePhotoIds = await usedPhotoIds(site);
  // Both extra query terms are per-tenant, and both used to be missing: with
  // no `topic` the list was [title, <fallback>], and the fallback was
  // buildImageQueries' hardcoded default — 'artificial intelligence
  // technology', which describes THIS repo's first tenant and no one else.
  // A dental or booking tenant whose post title didn't clear
  // MIN_RELEVANCE_SCORE fell through to an AI stock photo, and every such
  // post on every tenant converged on the same handful of images.
  const { topic, fallback } = await imageQueryContextFor(site);
  const image = await searchImage(buildImageQueries({ title, topic, fallback }), {
    excludePhotoIds,
    // searchImage's default of 5 is enough for a one-off repair and far too
    // few for a batch: every already-used photo is skipped, so a run of N
    // posts sharing a query needs more than N candidates or the tail returns
    // nothing and each post fails as "no relevant image". Widening the pool
    // is what makes the exclusion set above usable rather than exhausting.
    perPage: IMAGE_CANDIDATE_POOL,
  });
  if (!image) {
    throw Object.assign(
      new Error(`No relevant real image was found for "${title}" — a wrong photo is worse than none, so this is left for manual review rather than forcing a weak match.`),
      { status: 400, userFacing: true },
    );
  }

  return {
    content: {
      filePath,
      mode,
      title,
      imageUrl: image.url,
      imageAlt: image.alt || title,
      imageCredit: image.photographer ? `Photo by ${image.photographer} on Pexels` : null,
    },
    summary: mode === 'missing'
      ? `Add a featured image to "${title}"`
      : `Replace the ${mode === 'duplicate' ? 'duplicate' : 'broken'} featured image on "${title}"`,
  };
}
