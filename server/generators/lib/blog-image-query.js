import { getSiteProfile } from '../../store/data-analyst.js';

// The tenant-specific half of a featured-image search, shared by both
// generators that pick one: blog-outline.js (a brand-new post) and
// blog-image.js (repairing an existing post's missing/duplicate/broken image).
//
// It exists because buildImageQueries' `fallback` default is
// 'artificial intelligence technology' — an accurate description of this
// repo's FIRST tenant and of no other. Any post whose own title fails to
// clear MIN_RELEVANCE_SCORE against Pexels' captions falls through to that
// last-resort query, so on a dental or booking tenant the weak-title posts
// all converged on AI stock photography that had nothing to do with the site.
// Sourcing the fallback from site_profiles.industry keeps that last resort
// on-topic per tenant instead.
//
// Returns `fallback: undefined` (not null, not a guess) for a site with no
// profile row yet, which leaves buildImageQueries on its own documented
// default rather than inventing an industry for a tenant nothing is known
// about — the same honest-absence rule the image search itself follows.

// Pexels caps per_page at 80, so this uses the real cap rather than a
// smaller number sized only to a single day's batch. The pool has to exceed
// the SITE-WIDE exclusion set, not just one run's batch size: every already-
// claimed photo (usedPhotoIds — every featuredImage across the whole site,
// not just today's posts) is skipped, so a mature site's own exclusion set
// eventually outgrows a smaller pool regardless of how many posts are in the
// current run. Confirmed live on site 1 (2026-09-18): 80 already-used photo
// ids, a candidate pool of 40, and two brand-new posts ("Pixverse AI", "Top
// IT Companies Based in Nepal") that both failed with "no relevant image
// found" — every one of the top-40 Pexels results for their fallback/topic
// query was already excluded. Raising the pool to Pexels' actual max found a
// real, on-topic, unused match for both on the very next search. This isn't
// a one-off gap either: the exclusion set only grows as the site publishes
// more posts, so a pool sized below Pexels' cap gets less and less headroom
// over time — the old 40 comfortably covered a single day's batch size when
// this was written, but never accounted for the site's cumulative total.
export const IMAGE_CANDIDATE_POOL = 80;

export async function imageQueryContextFor(site) {
  let profile = null;
  try {
    profile = await getSiteProfile(site?.id);
  } catch (err) {
    console.error(`[blog-image-query] could not load site profile for site ${site?.id}:`, err.message);
  }
  if (!profile) return { topic: null, fallback: undefined };

  const mainTopics = Array.isArray(profile.main_topics) ? profile.main_topics.filter(Boolean) : [];
  const industry = profile.industry ? String(profile.industry).trim() : '';

  return {
    topic: mainTopics[0] ? String(mainTopics[0]) : null,
    fallback: industry || undefined,
  };
}
