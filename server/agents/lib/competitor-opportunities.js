// Turns competitor footprints into opportunities (Phase 4).
//
// The rule this module exists to enforce: comparing two keyword lists is NOT opportunity detection. A raw list diff
// produces work that is irrelevant, unwinnable, duplicated across rivals, or a second page competing with one we
// already have. Each of those is handled explicitly below, and anything that cannot be judged from evidence is left
// as insufficient data rather than guessed.
//
// What it does NOT do, deliberately:
//   - it does not decide anything is shipped. It produces scored candidates; the existing decision engine,
//     recommendation gates and autonomy rules stay the only things that decide (Phase 5).
//   - it does not call an LLM. Relevance against the client's real products is already judged by the existing
//     classifier (analyst-seo-mapping.js classifyGapRelevance) once a gap is in the queue; duplicating that here
//     would mean two different answers to the same question.
//   - it never invents a metric. A missing volume or difficulty stays null and lowers confidence instead.

export const OPPORTUNITY_TYPES = Object.freeze({
  MISSING: 'missing',
  POSITION_GAP: 'position_gap',
  TOPIC_GAP: 'topic_gap',
  SERVICE_LOCATION: 'service_location',
  IMPROVE_PAGE: 'improve_page',
  NEW_PAGE: 'new_page',
});

// We rank, but this far behind the best rival: worth acting on rather than ignoring as "already covered".
const POSITION_GAP_MIN_DELTA = 10;
// A page of ours ranking anywhere in this range is a real page with real signals: improve it, never write a rival to it.
const IMPROVABLE_POSITION_MAX = 30;
// How many distinct business rivals must be strong on a cluster before "nobody of ours covers this" is a topic gap.
const TOPIC_GAP_MIN_COMPETITORS = 3;
// A rival outside the top ten is not evidence that a keyword is winnable or important.
const COMPETITOR_STRONG_POSITION = 10;

/**
 * Build opportunities from competitor footprints and our own measured state.
 *
 * footprintRows: rows from store/competitor-footprint.js getAllLatestFootprints (business competitors only)
 * ourQueries:    our own GSC rows [{ query|dim_value, avg_position, impressions, page? }]
 * ourPages:      our pages with the keywords they already target [{ url, keywords: [] }] (from the existing
 *                keyword-coverage / page inventory reads) — used for the improve-vs-create decision
 * existingGaps:  every gap already in the queue for this project, any status, so nothing is proposed twice
 * serviceTerms:  the client's own verified service vocabulary
 * locations:     the markets this client targets
 *
 * Returns { opportunities[], rejected[] } — `rejected` keeps the reason a candidate was dropped, so a quiet run can
 * be explained instead of looking like an empty market.
 */
export function buildOpportunities({
  footprintRows = [],
  ourQueries = [],
  ourPages = [],
  existingGaps = [],
  serviceTerms = [],
  locationNames = [],
  learnedMultipliers = {},
  authorityScore = null,
} = {}) {
  // The client's own market names are what makes a keyword "location work"; without them no keyword is.
  const placeWords = new Set(locationNames.flatMap((n) => tokens(String(n).replace(/^the /i, ''))));
  const ours = indexOurQueries(ourQueries);
  const pageIndex = indexOurPages(ourPages);
  const taken = indexExistingGaps(existingGaps);
  const byKeyword = groupByKeyword(footprintRows);

  const opportunities = [];
  const rejected = [];

  for (const [keyword, competitors] of byKeyword) {
    // Only a rival genuinely in the top ten is evidence; a rival at 28 tells us nothing about winnability.
    const strong = competitors.filter((c) => c.position != null && c.position <= COMPETITOR_STRONG_POSITION);
    if (!strong.length) {
      rejected.push({ keyword, reason: 'no_competitor_in_top_10' });
      continue;
    }
    if (taken.has(normalizeKeyword(keyword))) {
      rejected.push({ keyword, reason: 'already_in_queue' });
      continue;
    }

    const best = strong.reduce((a, b) => (a.position <= b.position ? a : b));
    const demand = pickDemand(strong);
    const difficulty = pickDifficulty(strong);
    const intent = pickIntent(strong);
    const mine = ours.get(normalizeKeyword(keyword)) || null;
    const match = matchOurPage(keyword, pageIndex, mine);

    const type = decideType({ keyword, mine, match, strong, serviceTerms, placeWords });
    if (!type) {
      rejected.push({ keyword, reason: 'already_covered_and_competitive' });
      continue;
    }

    const evidence = {
      competitors: strong.slice(0, 5).map((c) => ({
        domain: c.competitor_domain, position: c.position, url: c.ranking_url, capturedAt: c.captured_at,
      })),
      competitorCount: strong.length,
      bestCompetitorPosition: best.position,
      ourPosition: mine?.position ?? null,
      ourPage: match?.url ?? null,
      matchedBy: match?.matchedBy ?? null,
      searchVolume: demand,
      keywordDifficulty: difficulty,
      searchIntent: intent,
      locationCode: strong[0].location_code ?? null,
      languageCode: strong[0].language_code ?? null,
    };

    const { score, confidence, parts } = scoreOpportunity({
      type, demand, difficulty, intent, competitorCount: strong.length,
      ourPosition: mine?.position ?? null, authorityScore,
      learnedMultiplier: learnedMultipliers[type],
    });

    opportunities.push({
      keyword: normalizeKeyword(keyword),
      opportunityType: type,
      score,
      confidence,
      scoreParts: parts,
      searchVolume: demand,
      keywordDifficulty: difficulty,
      searchIntent: intent,
      ourPosition: mine?.position ?? null,
      bestCompetitorPosition: best.position,
      existingPageMatch: match?.url ?? null,
      contentPlan: contentPlanFor(type),
      locationCode: evidence.locationCode,
      languageCode: evidence.languageCode,
      evidence,
      reason: explain({ type, keyword, best, strong, mine, match, demand }),
    });
  }

  // Several rivals strong on one cluster we do not cover at all is a stronger signal than any single keyword, so the
  // cluster is marked on the member opportunities rather than added as another row competing with them.
  markTopicGaps(opportunities, serviceTerms);

  opportunities.sort((a, b) => b.score - a.score);
  return { opportunities, rejected };
}

// ---------------------------------------------------------------------------
// What to do about it
// ---------------------------------------------------------------------------

// The improve-vs-create decision, and the reason this module cannot be a list diff. Order matters: anything that
// matches something we already have must become 'improve', because proposing a new page for a keyword an existing
// page targets is how a site ends up competing with itself.
function decideType({ keyword, mine, match, strong, serviceTerms, placeWords }) {
  // We already rank well: nothing to do, whatever rivals are doing.
  if (mine && mine.position != null && mine.position <= 3) return null;

  // A page of ours already targets this, or already ranks within improvable range -> improve that page.
  if (match) return OPPORTUNITY_TYPES.IMPROVE_PAGE;
  if (mine && mine.position != null && mine.position <= IMPROVABLE_POSITION_MAX) {
    const best = strong.reduce((a, b) => (a.position <= b.position ? a : b));
    return mine.position - best.position >= POSITION_GAP_MIN_DELTA
      ? OPPORTUNITY_TYPES.POSITION_GAP
      : OPPORTUNITY_TYPES.IMPROVE_PAGE;
  }

  // Nothing of ours ranks or matches. A service-plus-place phrase is its own kind of work (a location or service page),
  // which is why it is distinguished from a plain missing keyword.
  if (looksLikeServiceLocation(keyword, serviceTerms, placeWords)) return OPPORTUNITY_TYPES.SERVICE_LOCATION;
  return OPPORTUNITY_TYPES.MISSING;
}

// 'track' is the honest answer for a position gap: the work is on an existing page, so no new content is planned.
function contentPlanFor(type) {
  switch (type) {
    case OPPORTUNITY_TYPES.SERVICE_LOCATION: return 'landing';
    case OPPORTUNITY_TYPES.MISSING: return 'blog';
    case OPPORTUNITY_TYPES.NEW_PAGE: return 'blog';
    default: return 'track';
  }
}

function markTopicGaps(opportunities, serviceTerms) {
  const clusters = new Map();
  for (const o of opportunities) {
    const cluster = clusterFor(o.keyword, serviceTerms);
    if (!cluster) continue;
    o.topicCluster = cluster;
    if (!clusters.has(cluster)) clusters.set(cluster, []);
    clusters.get(cluster).push(o);
  }
  for (const [, members] of clusters) {
    const uncovered = members.filter((m) => !m.existingPageMatch && m.ourPosition == null);
    const rivals = new Set(uncovered.flatMap((m) => m.evidence.competitors.map((c) => c.domain)));
    if (uncovered.length >= 2 && rivals.size >= TOPIC_GAP_MIN_COMPETITORS) {
      // The highest-scoring member becomes the pillar; the rest support it. Both keep their own type so the generator
      // still knows whether it is writing a landing page or an article.
      const sorted = [...uncovered].sort((a, b) => b.score - a.score);
      sorted[0].clusterRole = 'pillar';
      sorted[0].topicGap = true;
      for (const m of sorted.slice(1)) { m.clusterRole = 'supporting'; m.topicGap = true; }
    }
  }
}

// ---------------------------------------------------------------------------
// Scoring: deliberately not search volume
// ---------------------------------------------------------------------------

/**
 * 0..1, an ordering only. Volume is one bounded part of one factor, so a huge irrelevant keyword cannot outrank a
 * modest keyword we can actually win on a page we already have. An unmeasured factor contributes its neutral value
 * and lowers confidence, rather than being guessed.
 */
export function scoreOpportunity({
  type, demand = null, difficulty = null, intent = null, competitorCount = 1,
  ourPosition = null, authorityScore = null, learnedMultiplier = null,
}) {
  // Demand, compressed: the difference between 50 and 500 searches matters; between 50,000 and 100,000 it does not.
  const demandPart = demand == null ? 0.4 : Math.min(Math.log10(demand + 1) / 4, 1);

  // Intent: what the searcher wants to do. Commercial and transactional intent is worth more to a business than
  // informational, which is a judgement about business value rather than about search.
  const intentPart = intent === 'transactional' ? 1 : intent === 'commercial' ? 0.85 : intent === 'informational' ? 0.5 : 0.6;

  // Winnability: difficulty against our own authority. Without either number this stays neutral.
  const winnability = difficulty == null
    ? 0.5
    : authorityScore == null
      ? Math.max(0, 1 - difficulty / 100)
      : clamp01((authorityScore / 100) + (1 - difficulty / 100) - 0.5);

  // Evidence strength: three rivals on one keyword is a market, one is an anecdote.
  const evidencePart = Math.min(competitorCount / 3, 1);

  // Capability: work on a page we already have is cheaper and safer than a new page, and position gaps are the
  // cheapest of all. This is what stops the system always preferring to write something new.
  const capabilityPart = type === OPPORTUNITY_TYPES.POSITION_GAP ? 1
    : type === OPPORTUNITY_TYPES.IMPROVE_PAGE ? 0.9
      : type === OPPORTUNITY_TYPES.SERVICE_LOCATION ? 0.6
        : 0.5;

  const base = demandPart * 0.2 + intentPart * 0.2 + winnability * 0.25 + evidencePart * 0.15 + capabilityPart * 0.2;

  // What this project's own verified outcomes say about this kind of work. Bounded so learning can inform the order
  // but never override the evidence, and absent until there are verified outcomes to learn from.
  const learned = typeof learnedMultiplier === 'number' ? clamp(learnedMultiplier, 0.7, 1.3) : 1;

  const measured = [demand, difficulty, intent].filter((v) => v != null).length;
  const confidence = measured === 3 ? 'high' : measured >= 1 ? 'medium' : 'low';

  return {
    score: Number(clamp01(base * learned).toFixed(3)),
    confidence,
    parts: { demandPart: round(demandPart), intentPart: round(intentPart), winnability: round(winnability), evidencePart: round(evidencePart), capabilityPart: round(capabilityPart), learned: round(learned) },
  };
}

// ---------------------------------------------------------------------------
// Indexing our own side
// ---------------------------------------------------------------------------

function indexOurQueries(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const q = normalizeKeyword(r.query ?? r.dim_value ?? r.keyword);
    if (!q) continue;
    const position = numberOrNull(r.avg_position ?? r.position);
    const impressions = numberOrNull(r.impressions);
    const prev = map.get(q);
    if (!prev || (position != null && (prev.position == null || position < prev.position))) {
      map.set(q, { position, impressions, page: r.page ?? null });
    }
  }
  return map;
}

function indexOurPages(pages) {
  return (pages || [])
    .filter((p) => p && p.url)
    .map((p) => ({
      url: p.url,
      keywords: new Set((p.keywords || []).map(normalizeKeyword).filter(Boolean)),
      words: new Set(tokens((p.title || '') + ' ' + p.url)),
    }));
}

function indexExistingGaps(gaps) {
  const set = new Set();
  for (const g of gaps || []) {
    const t = normalizeKeyword(g.topic ?? g.keyword);
    if (t) set.add(t);
  }
  return set;
}

// Does one of our pages already target this keyword? Exact targeting first, then every significant word of the
// keyword appearing in the page's own title/URL. A page we already rank with counts too — that page exists and has
// signals, so the work belongs there.
function matchOurPage(keyword, pageIndex, mine) {
  const k = normalizeKeyword(keyword);
  for (const page of pageIndex) {
    if (page.keywords.has(k)) return { url: page.url, matchedBy: 'targeted_keyword' };
  }
  const words = tokens(k);
  if (words.length) {
    for (const page of pageIndex) {
      if (words.every((w) => page.words.has(w))) return { url: page.url, matchedBy: 'page_title_or_url' };
    }
  }
  if (mine?.page && mine.position != null && mine.position <= IMPROVABLE_POSITION_MAX) {
    return { url: mine.page, matchedBy: 'already_ranking_page' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function groupByKeyword(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const k = normalizeKeyword(r.keyword);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// The strongest available measurement wins, and "nobody reported it" stays null.
function pickDemand(rows) {
  const values = rows.map((r) => numberOrNull(r.search_volume)).filter((v) => v != null);
  return values.length ? Math.max(...values) : null;
}
function pickDifficulty(rows) {
  const values = rows.map((r) => numberOrNull(r.keyword_difficulty)).filter((v) => v != null);
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}
function pickIntent(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!r.search_intent) continue;
    counts.set(r.search_intent, (counts.get(r.search_intent) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// A service-and-place search needs an actual PLACE, taken from the markets this client targets. Treating any leftover
// word as a place was wrong: "teeth whitening cost" and "teeth whitening near me" are modifiers, not locations, and
// calling them location work would send a landing-page generator at an article.
function looksLikeServiceLocation(keyword, serviceTerms, placeWords) {
  if (!placeWords.size) return false; // no market names known: cannot claim a keyword is location work
  const words = new Set(tokens(keyword));
  const serviceWords = new Set(serviceTerms.flatMap((t) => tokens(t)));
  const hasService = [...words].some((w) => serviceWords.has(w));
  const hasPlace = [...words].some((w) => placeWords.has(w));
  return hasService && hasPlace;
}

// The cluster is the client's own service term the keyword belongs to — their vocabulary, not an invented taxonomy.
function clusterFor(keyword, serviceTerms) {
  const words = new Set(tokens(keyword));
  let bestTerm = null;
  let bestOverlap = 0;
  for (const term of serviceTerms) {
    const termWords = tokens(term);
    if (!termWords.length) continue;
    const overlap = termWords.filter((w) => words.has(w)).length / termWords.length;
    if (overlap > bestOverlap) { bestOverlap = overlap; bestTerm = term; }
  }
  return bestOverlap >= 0.5 ? bestTerm : null;
}

function explain({ type, keyword, best, strong, mine, match, demand }) {
  const one = strong.length === 1;
  const who = `${strong.length} business ${one ? 'rival' : 'rivals'}`;
  const ranks = one ? 'ranks' : 'rank';
  const where = `best at position ${best.position} (${best.competitor_domain})`;
  const what = demand == null ? 'demand not reported by the provider' : `~${demand}/mo measured demand`;
  switch (type) {
    case OPPORTUNITY_TYPES.POSITION_GAP:
      return `We rank ${mine.position} for "${keyword}" while ${who} ${ranks} ahead, ${where}. ${what}. Improve the page that already ranks rather than adding another.`;
    case OPPORTUNITY_TYPES.IMPROVE_PAGE:
      return `"${keyword}" is already covered by ${match ? match.url : 'an existing page'} (${match ? match.matchedBy : 'already ranking'}), and ${who} ${ranks} for it, ${where}. ${what}. Strengthen that page.`;
    case OPPORTUNITY_TYPES.SERVICE_LOCATION:
      return `No page of ours targets "${keyword}" — a service-and-place search ${who} ${ranks} for, ${where}. ${what}.`;
    default:
      return `Nothing of ours ranks or matches "${keyword}", which ${who} ${ranks} for, ${where}. ${what}.`;
  }
}

const normalizeKeyword = (v) => (v == null ? null : String(v).trim().toLowerCase().replace(/\s+/g, ' ') || null);
const tokens = (v) => String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
const numberOrNull = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const clamp01 = (v) => clamp(v, 0, 1);
const round = (v) => Number(v.toFixed(3));
