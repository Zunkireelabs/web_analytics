// Picks which of N pages competing for the same real search query should be
// treated as the owner, from evidence query-intelligence.js already computes
// (getCannibalizedQueries' per-page clicks/impressions/avgPosition) — no new
// fetching, no invented signal.
//
// Deliberately NOT a "delete/redirect the loser" decision. Two of a site's
// own pages ranking for one query is resolved by making the winner's
// authority on that query unambiguous — reinforcing internal links toward it
// — while leaving every losing page's own content untouched. A 301/canonical
// merge is the wrong tool here: unlike duplicate-content (byte-identical
// bodies — the same content just needs one URL), cannibalizing pages are
// usually genuinely different articles that both happen to rank for one
// query, so merging or redirecting one away destroys real, separate content
// for a problem that internal linking alone already fixes (concentrates the
// ranking signal on the intended page without touching the other).
//
// Score composition, every component grounded in real measured data:
//   - clicks: the strongest signal — real converted search intent, weighted
//     far above impressions so a page that actually earns clicks beats one
//     that merely shows up.
//   - impressions: visibility, weighted lightly — same "demand can only ever
//     ADD, never gate" reasoning as growth-scoring.js's demandScore (a page
//     can have real position/clicks with modest impressions on a small
//     site).
//   - position: closer to page 1 is real, measured ranking strength.
//   - relevance: a query keyword appearing in the page's own URL slug is a
//     real, on-page-declared signal that THIS page was built to answer that
//     query — not inferred, read directly off the URL the site itself
//     chose.
//   - homepage penalty: the homepage winning a specific long-tail commercial
//     query over a dedicated page would hand query ownership to the site's
//     most generic page — almost never the intended target, and a dedicated
//     page losing its own topic to the homepage is the failure mode this
//     guards against.
const CLICKS_WEIGHT = 20;
const IMPRESSIONS_WEIGHT = 1;
const POSITION_WEIGHT = 5; // per rank point closer to 1, capped at position 20
const RELEVANCE_BONUS = 50;
const HOMEPAGE_PENALTY = 100;

function isHomepage(pageUrl) {
  try {
    const { pathname } = new URL(pageUrl);
    return pathname === '/' || pathname === '';
  } catch {
    return false;
  }
}

// Real query keywords (3+ letters, so "a"/"in"/"of" never count) found in
// the page's own URL path — the site's own declared topic for that page,
// not a guess at intent.
function slugMatchesQuery(pageUrl, query) {
  let path;
  try {
    path = new URL(pageUrl).pathname.toLowerCase();
  } catch {
    return false;
  }
  const slugWords = path.split(/[^a-z0-9]+/).filter(Boolean);
  const queryWords = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!queryWords.length) return false;
  return queryWords.some((w) => slugWords.includes(w));
}

function scorePage(page, query) {
  const clicks = Number(page.clicks) || 0;
  const impressions = Number(page.impressions) || 0;
  const avgPosition = page.avgPosition != null ? Number(page.avgPosition) : null;
  const factors = [];
  let score = 0;

  score += clicks * CLICKS_WEIGHT;
  if (clicks) factors.push(`clicks=${clicks} (+${clicks * CLICKS_WEIGHT})`);

  score += impressions * IMPRESSIONS_WEIGHT;
  if (impressions) factors.push(`impressions=${impressions} (+${(impressions * IMPRESSIONS_WEIGHT).toFixed(0)})`);

  if (avgPosition != null) {
    const positionBonus = Math.max(0, 20 - avgPosition) * POSITION_WEIGHT;
    score += positionBonus;
    factors.push(`avgPosition=${avgPosition.toFixed(1)} (+${positionBonus.toFixed(0)})`);
  }

  if (slugMatchesQuery(page.page, query)) {
    score += RELEVANCE_BONUS;
    factors.push(`URL slug names a query keyword (+${RELEVANCE_BONUS})`);
  }

  if (isHomepage(page.page)) {
    score -= HOMEPAGE_PENALTY;
    factors.push(`homepage, not a dedicated page for this query (-${HOMEPAGE_PENALTY})`);
  }

  return { page: page.page, score, factors, clicks, impressions, avgPosition };
}

/**
 * @param {string} query the cannibalized query
 * @param {Array<{page:string, clicks:number, impressions:number, avgPosition:number}>} pages
 * @returns {{winner:string, losers:string[], scoring:Array}} stable
 *   regardless of input order — ties break on higher clicks, then shorter
 *   path (more specific-looking), then alphabetically, so the same
 *   cannibalization group always resolves to the same winner run to run.
 */
export function pickCannibalizationWinner(query, pages) {
  const scored = pages.map((p) => scorePage(p, query));
  scored.sort((a, b) => (
    b.score - a.score
    || b.clicks - a.clicks
    || a.page.length - b.page.length
    || a.page.localeCompare(b.page)
  ));
  const [winner, ...losers] = scored;
  return { winner: winner.page, losers: losers.map((l) => l.page), scoring: scored };
}
