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

// Place names are strong, common Pexels keywords for travel/scenery
// photography, not for whatever industry the post is actually about. A
// title's own place name is often a deliberate local-SEO keyword (e.g. "IT
// Companies in Nepal", a genuine target keyword for a Nepal-based tech
// company) and must never by itself be enough to win a match against a
// temple/mountain/street photo that has nothing to do with the post's real
// subject. Stripped from both the text sent to Pexels and the terms scored,
// so the search and the relevance check run on what the post is actually
// about, not on where its target market happens to be.
const LOCATION_TERMS = new Set([
  'nepal', 'nepali', 'nepalese', 'kathmandu', 'pokhara', 'lalitpur', 'bhaktapur',
  'pashupatinath', 'himalaya', 'himalayan', 'himalayas', 'everest', 'annapurna',
]);

function significantWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !LOCATION_TERMS.has(w));
}

// Removes only place-name words from the text actually sent to Pexels'
// search endpoint, leaving everything else — including short-but-meaningful
// words like "AI" that significantWords' length filter drops for scoring
// purposes — intact. Scoring and search must strip location terms the same
// way, but search must not also inherit scoring's unrelated length/stopword
// filtering, or a core topic keyword like "AI" would silently stop reaching
// Pexels at all.
function stripLocationWords(text) {
  return (text || '')
    .split(/\s+/)
    .filter((w) => !LOCATION_TERMS.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')))
    .join(' ');
}

// Generic stock-photo filler that photographers tag literally as such — a
// clean relevance score on "isolated on white background" is still a bad
// featured image for a blog post. Penalized rather than excluded outright,
// since a real match can still legitimately carry one of these words.
// The literal "toy robot" cliché this file's own top comment describes as
// the original bug is still reachable through the FALLBACK query alone:
// 'artificial intelligence technology' has only 3 significant terms, so a
// candidate sharing just ONE generic word ("technology", "innovation") with
// it already scores ~0.33-0.38 — enough to clear MIN_RELEVANCE_SCORE — and
// Pexels' own top results for that query are dominated by humanoid-robot
// stock photography. 'robot'/'humanoid'/etc. are penalized the same way as
// the other generic-stock terms here: a real, specific match (e.g. a title
// genuinely about robotics) can still win on its OTHER significant words,
// but this can no longer be the entire reason a fallback-query candidate
// clears the bar.
const GENERIC_STOCK_TERMS = new Set([
  'isolated', 'clipart', 'vector', 'icon', 'template', 'mockup', 'copyspace', 'copy space',
  'robot', 'robots', 'robotic', 'humanoid', 'cyborg', 'android', 'futuristic',
]);

// Hard exclusion, not a scoring penalty — a title containing an emotionally
// loaded word like "struggles" or "challenges" can score a real, high
// relevance match against a photo whose alt text uses the same word for a
// completely different (and often sensitive/inappropriate) reason: this is
// how "Navigating Challenges: The Struggles of AI Companies in Nepal" landed
// a wheelchair-on-stairs accessibility-struggle photo as a blog's featured
// image. No score is high enough to excuse this category ever appearing on
// a client site, so a candidate matching any of these is dropped from the
// pool entirely, before scoring runs — the query can still win on its
// OTHER significant words against a different, real candidate, or fall
// through to a later, broader query exactly as an empty-result page would.
const SENSITIVE_CONTENT_TERMS = new Set([
  'wheelchair', 'wheelchairs', 'disability', 'disabled', 'disabilities',
  'amputee', 'amputation', 'prosthetic', 'prosthesis', 'crutches',
  'injury', 'injured', 'wound', 'wounded', 'bleeding', 'blood',
  'hospital', 'patient', 'ambulance', 'emergency', 'surgery', 'ill', 'illness',
  'funeral', 'coffin', 'grave', 'grief', 'grieving', 'mourning', 'crying',
  'depression', 'depressed', 'suicide', 'self-harm', 'addiction',
  'violence', 'violent', 'abuse', 'assault', 'war', 'weapon', 'gun', 'combat',
  'refugee', 'poverty', 'homeless', 'starvation', 'famine', 'disaster',
  'nude', 'naked', 'nudity',
]);

// Word-boundary substring matching directly on the raw alt text, not
// tokenized like significantWords — a multi-word term like "self-harm"
// would never survive significantWords' punctuation-stripping into a single
// token, and this check must not miss it.
const SENSITIVE_CONTENT_PATTERN = new RegExp(
  `\\b(${[...SENSITIVE_CONTENT_TERMS].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

function hasSensitiveContent(altText) {
  return SENSITIVE_CONTENT_PATTERN.test(altText || '');
}

// Hard exclusion, same reasoning as SENSITIVE_CONTENT_TERMS above but for a
// different failure: a title's own ordinary English words ("store", "best")
// can match Pexels alt text that only contains them because the photo is of
// a real third-party company's storefront/signage — "Exploring AI Store
// Innovations in Nepal" matched a Google Store photo on "store", and
// "Exploring the Best IT Companies in Nepal" matched a Seattle's Best Coffee
// sign on "best". Publishing a real, unrelated brand's storefront on a
// client's own blog is a brand-safety problem regardless of how well the
// surrounding words score, so any of these full brand names/phrases in a
// candidate's alt text disqualifies it outright, the same way a sensitive-
// content term does. Deliberately specific multi-word phrases (never a bare
// generic word like "best" or "store" alone) so this can't gut ordinary
// matches that just happen to use common retail vocabulary.
const BRAND_NAME_TERMS = [
  'google store', 'apple store', 'microsoft store', 'samsung store', 'sony store',
  "seattle's best coffee", 'starbucks', 'best buy', "mcdonald's", 'burger king',
  'kfc', 'subway restaurant', 'whole foods', "trader joe's", 'walmart', 'target store',
  'costco', 'nordstrom', '7-eleven', 'ikea', 'nike store', 'adidas store',
  'coca-cola', 'pepsi', 'amazon fulfillment', 'facebook', 'instagram logo',
  'netflix', 'disney store', 'gucci', 'chanel', 'zara store', 'h&m store',
  'toyota', 'honda', 'bmw', 'mercedes-benz', 'audi', 'tesla showroom',
];

const BRAND_NAME_PATTERN = new RegExp(
  `\\b(${BRAND_NAME_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

function hasBrandMention(altText) {
  return BRAND_NAME_PATTERN.test(altText || '');
}

// Hard exclusion, same reasoning as SENSITIVE_CONTENT_TERMS/BRAND_NAME_TERMS
// above: a Nepal-based tenant's post can score a real relevance match
// against a photo that has nothing to do with the post's actual business
// topic, purely because Pexels' catalog for Nepal-adjacent search terms
// skews toward tourism/culture cliché photography — a mountain temple, a
// weaver at a loom, someone's hands shaping pottery, a coffee-shop
// interior. LOCATION_TERMS already stops a bare place name from winning a
// match on its own, but a candidate can still clear the bar on OTHER
// overlapping words while its alt text is unmistakably one of these
// clichés — real reported complaint: a business/technology post ending up
// illustrated with generic Nepali scenery, a cafe interior, or an
// artisan's-hands-at-work photo, none of which represent the actual post.
const OFF_TOPIC_CLICHE_TERMS = [
  'temple', 'monastery', 'stupa', 'pagoda', 'prayer flag', 'prayer flags',
  'trekking', 'sherpa', 'himalayan peak', 'mountain village', 'rural village',
  'traditional village', 'rice paddy', 'rice terrace',
  'cafe', 'coffee shop', 'espresso', 'cappuccino', 'latte', 'barista', 'coffee cup',
  'handicraft', 'handicrafts', 'artisan', 'artisans', 'craftsman', 'craftswoman',
  'handloom', 'handwoven', 'weaving', 'loom', 'pottery', 'potter', 'wood carving',
  'woodcarving', 'embroidery', 'basket weaving', 'handmade craft',
];

const OFF_TOPIC_CLICHE_PATTERN = new RegExp(
  `\\b(${OFF_TOPIC_CLICHE_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

function isOffTopicCliche(altText) {
  return OFF_TOPIC_CLICHE_PATTERN.test(altText || '');
}

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

async function fetchCandidates(query, perPage, page = 1) {
  const url = `${BASE}/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape&page=${page}`;
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

// A Pexels photo URL always embeds the real numeric photo id
// (.../photos/{id}/pexels-photo-{id}.jpeg?...) regardless of the size/crop
// query string a caller stored — matching on this id, not the stored URL
// string, is what lets a caller detect "this exact photo is already used
// somewhere on the site" even if it was saved with different query params.
export function pexelsPhotoIdFromUrl(url) {
  const m = /\/photos\/(\d+)\//.exec(url || '');
  return m ? Number(m[1]) : null;
}

// Best-effort: any failure (network, timeout, no results, bad key) returns
// null rather than throwing — a missing featured image must never block a
// blog draft that is otherwise complete (same reasoning as blog-outline.js's
// homepage-grounding fetch).
//
// `queries`: ordered most-specific first (e.g. the post's real title), most-
// generic last (a broad industry fallback) — see buildImageQueries. Queries
// are tried IN ORDER, not pooled: the first query whose best candidate
// clears MIN_RELEVANCE_SCORE wins outright, and later (broader) queries are
// never even fetched. Pooling used to let the fallback query's own generic
// candidate ("artificial intelligence technology" scored against a photo
// captioned almost the same words) beat a genuinely on-topic title match
// just by scoring marginally higher — which is why so many unrelated posts
// converged on the same handful of stock photos. The fallback is now a true
// last resort: it only gets used when every more-specific query came back
// with nothing good enough.
//
// `excludePhotoIds`: photo ids (see pexelsPhotoIdFromUrl) already in use
// elsewhere on this site — skipped even if they'd otherwise win, so a new or
// repaired post never lands on an image another post is already using.
// A query only ever advances past page 1 when page 1's best candidate
// didn't clear MIN_RELEVANCE_SCORE — confirmed live on site 1 (2026-09-18):
// with 81 photo ids already excluded (site-wide usedPhotoIds, growing as the
// site publishes more posts), the fallback query's page-1 best scored 0.30
// (just under the 0.34 bar), while page 2 of that SAME query had a clean
// 0.55 match. A mature site's exclusion set eventually shadows enough of
// page 1's results that a real, on-topic, unused photo can sit just one page
// further down — a query this generator would otherwise give up on entirely.
// Bounded to 2 pages per query (not unbounded) since this only fires on a
// query that already failed once, and each extra page is a real Pexels API
// call.
const MAX_PEXELS_PAGES = 2;

export async function searchImage(queries, { perPage = 5, excludePhotoIds } = {}) {
  const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean);
  if (!configured() || !list.length) return null;

  for (const query of list) {
    const terms = significantWords(query);
    if (!terms.length) continue;
    // Strip place names from the text actually sent to Pexels too, not just
    // from scoring — otherwise a location word in the title (see
    // LOCATION_TERMS) still floods the candidate pool with travel photos
    // before relevance scoring ever gets a say.
    const strippedQuery = stripLocationWords(query);
    for (let page = 1; page <= MAX_PEXELS_PAGES; page++) {
      // eslint-disable-next-line no-await-in-loop
      const photos = await fetchCandidates(strippedQuery, perPage, page);
      let best = null;
      let bestScore = -Infinity;
      for (const photo of photos) {
        if (excludePhotoIds?.has(photo.id)) continue;
        if (hasSensitiveContent(photo.alt)) continue;
        if (hasBrandMention(photo.alt)) continue;
        if (isOffTopicCliche(photo.alt)) continue;
        const score = scoreCandidate(photo, terms);
        if (score > bestScore) { bestScore = score; best = photo; }
      }
      if (best && bestScore >= MIN_RELEVANCE_SCORE) return toResult(best);
      if (photos.length < perPage) break; // no further pages exist
    }
  }
  return null;
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
