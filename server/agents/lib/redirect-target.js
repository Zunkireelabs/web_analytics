// Picks the live page a dead URL should redirect to. Pure and deterministic —
// no LLM, so the destination can never be an invented URL: it is always one of
// the site's own pages that was just fetched and served 200.
//
// Returns null whenever the match is not clearly the one right page. A dead
// URL with no confident target stays report-only for a human; a wrong
// redirect is worse than a 404 because it silently sends visitors (and the
// ranking signal) somewhere unrelated.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'from', 'with', 'by', 'at', 'is', 'are',
  'how', 'what', 'why', 'your', 'you', 'guide', 'complete', 'best', 'top', 'new',
]);
const YEAR = /^20\d{2}$/;

// Path prefixes that exist only because of a past URL structure.
const LEGACY_PREFIXES = ['/blogs/', '/blog/', '/posts/', '/articles/'];

export function pathOf(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return null; }
}

function stripLegacy(path) {
  for (const p of LEGACY_PREFIXES) {
    if (path.startsWith(p)) return `/${path.slice(p.length)}`;
  }
  return path;
}

export function slugTokens(path) {
  const last = stripLegacy(path).split('/').filter(Boolean).pop() || '';
  return last
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t) && !YEAR.test(t));
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return { score: shared / (A.size + B.size - shared), shared };
}

// deadUrl: string. liveUrls: string[] of own pages that returned 200 and are
// indexable. Same host only — a redirect never leaves the site.
export function pickRedirectTarget(deadUrl, liveUrls, { minScore = 0.6, minShared = 2, minMargin = 0.15 } = {}) {
  const deadPath = pathOf(deadUrl);
  if (!deadPath || deadPath === '/') return null;
  let deadHost;
  try { deadHost = new URL(deadUrl).hostname.replace(/^www\./, ''); } catch { return null; }

  const sameHost = (liveUrls || []).filter((u) => {
    try { return new URL(u).hostname.replace(/^www\./, '') === deadHost && pathOf(u) !== deadPath; } catch { return false; }
  });

  // 1. The same page under an older URL structure (/blogs/x -> /x).
  const stripped = stripLegacy(deadPath);
  if (stripped !== deadPath) {
    const exact = sameHost.find((u) => pathOf(u) === stripped);
    if (exact) return { url: exact, score: 1, basis: 'legacy-prefix' };
  }

  // 2. Closest slug. A page must share real words with the dead URL, clear a
  // score floor, and beat the runner-up by a margin — two equally plausible
  // targets mean nobody should be guessing.
  const dead = slugTokens(deadPath);
  const scored = sameHost
    .map((u) => ({ url: u, ...jaccard(dead, slugTokens(pathOf(u))) }))
    .filter((c) => c.shared >= minShared && c.score >= minScore)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  if (!scored.length) return null;
  if (scored[1] && scored[0].score - scored[1].score < minMargin) return null;
  return { url: scored[0].url, score: Number(scored[0].score.toFixed(2)), basis: 'slug-similarity' };
}
