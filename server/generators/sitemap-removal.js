// Pure, deterministic generator — same shape as soft-404-nginx.js/redirect-
// chain-nginx.js: the real work (re-fetching the live sitemap, finding the
// exact matching <url> block, refusing all-or-nothing if anything's
// changed) happens in the implementer
// (server/implementers/lib/sitemap-removal-inject.js) at apply time.

export const meta = {
  id: 'sitemap-removal',
  name: 'Sitemap Entry Removal Generator',
  description: 'Drafts the removal of specific URL(s) from the sitemap that Google\'s own index inspection confirms are currently blocked, excluded, or non-canonical — aligns the sitemap with confirmed reality without touching the underlying robots/noindex/canonical signal itself.',
  recommendationTags: [],
};

// params: { page: string, removeUrls: string[] } — page is the primary URL
// this recommendation is about (its own dedup identity); removeUrls is
// almost always just [page], kept as its own array for symmetry with the
// implementer's all-or-nothing multi-URL support, should a future caller
// ever want to batch several confirmed-blocked sitemap entries into one PR.
export async function generate({ params }) {
  const { removeUrls } = params || {};
  if (!Array.isArray(removeUrls) || !removeUrls.length) {
    throw Object.assign(new Error('removeUrls (a non-empty array) is required'), { status: 400 });
  }
  return {
    content: { removeUrls },
    summary: `Remove ${removeUrls.length} URL(s) from the sitemap that Google's own inspection confirms are currently blocked/excluded/non-canonical: ${removeUrls.join(', ')}.`,
  };
}
