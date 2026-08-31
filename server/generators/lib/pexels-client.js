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

// searchImage used to take ONE query (the post title) and return Pexels'
// single top result unconditionally — whatever the API's ranking put first,
// with nothing checking it actually matched the post. That is how
// "Future Trends in AI Development in Nepal" got a stock photo of a toy robot:
// a real, on-topic-sounding Pexels result for the word "AI", and nothing to
// tell it apart from an image that actually illustrates the post.
//
// Real relevance signal, no new API or cost: Pexels returns real alt text per
// photo, written by its own contributors/curators to describe what's actually
// in the frame. Scoring candidates against the query's own significant words
// is a genuine (if approximate) check of "does this picture match the topic",
// not just "did Pexels return it first".

// Words too common to mean anything about a topic — excluded from both the
// query terms scored against and the alt-text tokens scored. Kept deliberately
// short: this only needs to strip noise, not parse English.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'of', 'in', 'on', 'at', 'to',
  'is', 'are', 'was', 'were', 'be', 'with', 'by', 'from', 'as', 'that', 'this',
  'how', 'what', 'why', 'guide', 'understanding', 'exploring', 'unlocking',
]);

function significantWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Generic stock-photo filler that photographers tag literally as such — a
// clean relevance score on "isolated on white background" is still a bad
// featured image for a blog post. Penalized rather than excluded outright,
// since a real match can still legitimately carry one of these words.
const GENERIC_STOCK_TERMS = new Set(['isolated', 'clipart', 'vector', 'icon', 'template', 'mockup', 'copyspace', 'copy space']);

function scoreCandidate(photo, queryTerms) {
  if (!photo?.alt) return 0;
  const altWords = new Set(significantWords(photo.alt));
  if (!altWords.size || !queryTerms.length) return 0;
  const overlap = queryTerms.filter((t) => altWords.has(t)).length;
  let score = overlap / queryTerms.length;
  for (const term of GENERIC_STOCK_TERMS) if (altWords.has(term)) score -= 0.15;
  // A portrait crop of a landscape photo is unlikely to be the actual subject
  // Pexels' alt text describes; a genuinely landscape-shot photo scores a
  // small bonus since it's what a blog hero image needs anyway.
  if (photo.width && photo.height && photo.width / photo.height >= 1.3) score += 0.05;
  return score;
}

async function fetchCandidates(query, perPage) {
  const url = `${BASE}/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Authorization: process.env.PEXELS_API_KEY } });
    if (!res.ok) return [];
    const json = await res.json();
    return json?.photos || [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function toResult(photo) {
  if (!photo?.src?.large) return null;
  return {
    url: photo.src.large,
    alt: photo.alt || '',
    photographer: photo.photographer || null,
    photographerUrl: photo.photographer_url || null,
  };
}

// A candidate has to clear this to be used at all. Below it, "no image" beats
// a wrong one — this is the actual fix for the original complaint: the old
// code always returned SOMETHING, so a topic with no good stock match still
// got a plausible-looking but unrelated photo. 0.34 means roughly a third of
// a query's significant words show up in the photo's own description; tuned
// against the real queries this file's test fixtures use, not a guess.
const MIN_RELEVANCE_SCORE = 0.34;

// Best-effort: any failure (network, timeout, no results, bad key) returns
// null rather than throwing — a missing featured image must never block a
// blog draft that is otherwise complete (same reasoning as blog-outline.js's
// homepage-grounding fetch).
//
// `queries`: ordered most-specific first (e.g. the post's real title), most-
// generic last (a broad industry fallback) — see buildImageQueries. Every
// query's results are pooled and scored together, so a weaker match from an
// earlier, more specific query can still lose to a stronger match from a
// later, broader one; only the single best-scoring candidate across all of
// them is returned, and only if it clears MIN_RELEVANCE_SCORE.
export async function searchImage(queries, { perPage = 5 } = {}) {
  const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean);
  if (!configured() || !list.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const query of list) {
    const terms = significantWords(query);
    if (!terms.length) continue;
    const photos = await fetchCandidates(query, perPage);
    for (const photo of photos) {
      const score = scoreCandidate(photo, terms);
      if (score > bestScore) { bestScore = score; best = photo; }
    }
  }

  if (!best || bestScore < MIN_RELEVANCE_SCORE) return null;
  return toResult(best);
}

// Builds the ordered query list from whatever a generator/backfill script has
// on hand. Most specific candidate first (the real title says the most about
// what a reader expects to see); a broad, always-on-topic fallback last, so a
// post about a narrow product feature still has a shot at a relevant AI/tech
// image rather than returning nothing.
export function buildImageQueries({ title, topic, fallback = 'artificial intelligence technology' } = {}) {
  const queries = [];
  if (title) queries.push(title);
  if (topic && topic !== title) queries.push(topic);
  if (fallback) queries.push(fallback);
  return queries;
}
