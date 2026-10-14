import { configured as imagesConfigured } from './pexels-client.js';

// A blog post shipping with no featured image at all is visually incomplete
// on every site's article template (a hero-image slot renders empty) — see
// blog-outline.js's own comment on the real incident this closes: a mature
// site (94 already-used photos) exhausted title/topic/industry queries
// entirely for a generic "AI" post, and the draft shipped anyway with no
// image. blog-outline.js now also tries each section's own heading before
// giving up (a real, confirmed fix for that specific case), but Pexels'
// catalog can still genuinely have nothing left for a niche/exhausted topic
// — this is the safety net for exactly that remaining case, same two-tier
// "enforced for unattended runs, visible-but-non-blocking for a human
// waiting on Generate" split as design-integrity-guard.js.
const CHECKED_GENERATOR_IDS = new Set(['blog-outline']);

/**
 * @returns {{issues: Array<{path, patternId, snippet, detail, blocking}>}}
 * Same shape every sibling Quality Gate checker returns. A no-op for any
 * generator other than blog-outline, or when images aren't configured/
 * enabled for this deployment at all (BLOG_IMAGES_ENABLED/PEXELS_API_KEY) —
 * shipping with no image is expected, not a defect, on a deployment where
 * image search was never on.
 */
export function findBlogImageIssues(generatorId, content, { enforce = true } = {}) {
  if (!CHECKED_GENERATOR_IDS.has(generatorId) || !imagesConfigured()) return { issues: [] };
  if (content?.featuredImage) return { issues: [] };
  return {
    issues: [{
      path: 'featuredImage',
      patternId: 'missing-featured-image',
      snippet: '(none)',
      detail: 'No relevant, unused stock image was found for this post (every title/topic/section-heading/industry query came back empty or below the relevance bar) — this post would ship with no featured image.',
      blocking: enforce,
    }],
  };
}
