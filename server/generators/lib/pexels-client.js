// Pexels image search — the featured-image source for blog-outline.js.
// Deliberately NOT just "is PEXELS_API_KEY set" — mirrors
// agents/lib/model-providers/openai.js's AI_RECOMMENDATION_ENABLED pattern:
// BLOG_IMAGES_ENABLED is this feature's own dedicated gate, so a key
// present for some other reason can never silently turn image-fetching on.
// Free tier, no per-request cost, so no budget/cadence gate is needed here
// the way DataForSEO's paid-per-call endpoints get one.

const BASE = 'https://api.pexels.com/v1';
const FETCH_TIMEOUT_MS = 8000; // a single keyword image search, not a slow crawl-index lookup

export function configured() {
  return !!process.env.PEXELS_API_KEY && process.env.BLOG_IMAGES_ENABLED === 'true';
}

// Best-effort: any failure (network, timeout, no results, bad key) returns
// null rather than throwing — a missing featured image must never block a
// blog draft that is otherwise complete (same reasoning as blog-outline.js's
// homepage-grounding fetch).
export async function searchImage(query) {
  if (!configured() || !query) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${BASE}/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: process.env.PEXELS_API_KEY },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const photo = json?.photos?.[0];
    if (!photo?.src?.large) return null;
    return {
      url: photo.src.large,
      alt: photo.alt || query,
      photographer: photo.photographer || null,
      photographerUrl: photo.photographer_url || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
