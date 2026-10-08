// Per-site policy for whether a blog post gets a Pexels featured image.
//
// Default (no setting) is the long-standing behaviour: every blog post gets
// one. A site opts into `newContentTargets['blog-outline'].featuredImage =
// 'insights-only'` when its blog already has its own image-less design that it
// wants kept: zunkireelabs.com's blog card falls back to a brand-green gradient
// for a post with no featuredImage, and the owner wants regular posts to keep
// that look while Insights (trend explainers) get a Pexels photo. Per site on
// purpose — other tenants' blogs depend on the default.

// The blog category trend-radar files its posts under, and the one label that
// counts as an "insight" for this policy.
export const INSIGHT_CATEGORY = 'Insights';

export function featuredImageWanted(target, { category } = {}) {
  if (target?.featuredImage === 'insights-only') return category === INSIGHT_CATEGORY;
  return true;
}

// Whether blog-outline should search for a stock (Pexels) photo for this post.
//
// A site with generated gradient covers (lib/gradient-cover.js) builds a cover
// for every post at apply time, so by default it wants NO stock photo. The one
// exception is a site that ALSO set `featuredImage: 'insights-only'`: its
// Insights posts keep a Pexels photo and every other post gets the gradient.
// A site without covers keeps the long-standing rule (featuredImageWanted).
export function stockPhotoWanted(target, { category, hasCover = false } = {}) {
  if (hasCover) return target?.featuredImage === 'insights-only' && category === INSIGHT_CATEGORY;
  return featuredImageWanted(target, { category });
}

// Reads the front-matter `category:` of an existing post (quoted or bare);
// null when absent.
export function extractCategory(raw) {
  const m = /^category:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(raw || '');
  return m ? m[1].trim() : null;
}
