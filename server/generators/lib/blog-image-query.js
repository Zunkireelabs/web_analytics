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

// Pexels caps per_page at 80. 40 comfortably covers a full day's batch (the
// largest observed was 39 posts in one Action Center run) in a single request
// per query. The pool has to exceed the batch size: every already-claimed
// photo is skipped, so with the old default of 5 a run of N > 5 posts sharing
// a query exhausts its candidates and every post after the fifth fails as
// "no relevant image found". Widening the pool is what makes de-duplication
// usable rather than self-defeating.
export const IMAGE_CANDIDATE_POOL = 40;

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
