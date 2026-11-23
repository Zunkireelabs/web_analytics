// "Do these two keywords want the same page?" answered from what Google itself ranks, not from how the words look: two keywords whose
// top-10 results share most of their URLs are one topic and belong on ONE page; two whose results share almost nothing need separate
// pages. Text similarity (what the embedding clustering in data-analyst-agent does) cannot tell "best crm" from "crm software" the way
// the results page can.
//
// Method and thresholds follow claude-seo's SERP-overlap methodology (MIT, (c) 2026 agricidaniel; skill by Lutfiya Miller):
//   7-10 shared results  -> same page       merge the keywords into one target page
//   4-6                  -> same cluster    group them, separate posts or one, by volume
//   2-3                  -> interlink       adjacent clusters, link between them
//   0-1                  -> separate        different pages
// The ambiguous scores are 3 and 4, and they lean toward keeping keywords together: 4 stays a cluster unless one keyword has 10x the
// volume of the other; 3 becomes a cluster only when intent AND sites agree too.
// Pure: URL lists in, groups out. Fetching the results is the caller's job (see lib/serp.js), because that is what costs money.

export const RELATION = { SAME_PAGE: 'same-page', SAME_CLUSTER: 'same-cluster', INTERLINK: 'interlink', SEPARATE: 'separate' };

// protocol, "www.", trailing slash, fragment and query string are not part of which page ranks
export function normalizeSerpUrl(input) {
  try {
    const u = new URL(String(input).trim());
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${u.pathname.replace(/\/+$/, '') || ''}`;
  } catch { return ''; }
}
const domainOf = (norm) => norm.split('/')[0];

/** How many of the top results two keywords share (0-10). */
export function overlapScore(urlsA = [], urlsB = []) {
  const a = new Set(urlsA.map(normalizeSerpUrl).filter(Boolean));
  const b = new Set(urlsB.map(normalizeSerpUrl).filter(Boolean));
  let shared = 0;
  for (const u of a) if (b.has(u)) shared += 1;
  return Math.min(shared, 10);
}

function domainOverlap(urlsA, urlsB) {
  const a = new Set(urlsA.map(normalizeSerpUrl).filter(Boolean).map(domainOf));
  const b = new Set(urlsB.map(normalizeSerpUrl).filter(Boolean).map(domainOf));
  let shared = 0;
  for (const d of a) if (b.has(d)) shared += 1;
  return shared;
}

const isLopsided = (a, b) => {
  const x = Number(a.volume) || 0; const y = Number(b.volume) || 0;
  return x > 0 && y > 0 && Math.max(x, y) / Math.min(x, y) >= 10;
};

/**
 * @param a, b  { urls: string[], intent?: string, volume?: number }
 * @returns { score, relation, reason }
 */
export function relateKeywords(a, b) {
  const score = overlapScore(a.urls, b.urls);
  if (score >= 7) return { score, relation: RELATION.SAME_PAGE, reason: `${score} of the top 10 results are the same pages` };
  if (score >= 5) return { score, relation: RELATION.SAME_CLUSTER, reason: `${score} shared results` };
  if (score === 4) {
    // 4 sits in the "same cluster" band; the one clear reason to split is a 10x volume gap (the big keyword deserves its own post).
    // In doubt, keep them together.
    return isLopsided(a, b)
      ? { score, relation: RELATION.INTERLINK, reason: '4 shared results, but one keyword has 10x the volume of the other' }
      : { score, relation: RELATION.SAME_CLUSTER, reason: '4 shared results' };
  }
  if (score === 3) {
    // 3 is the edge of "interlink". It is promoted to the same cluster only when everything else agrees.
    const sameIntent = Boolean(a.intent && b.intent && a.intent === b.intent);
    const sameSites = domainOverlap(a.urls, b.urls) >= 5;
    return sameIntent && sameSites && !isLopsided(a, b)
      ? { score, relation: RELATION.SAME_CLUSTER, reason: '3 shared results, the same intent and mostly the same sites' }
      : { score, relation: RELATION.INTERLINK, reason: '3 shared results' };
  }
  if (score === 2) return { score, relation: RELATION.INTERLINK, reason: '2 shared results' };
  return { score, relation: RELATION.SEPARATE, reason: score === 1 ? '1 shared result' : 'no shared results' };
}

/**
 * Groups keywords by what Google ranks for them.
 * @param keywords [{ keyword, urls, volume?, intent? }]  keywords with no results at all are left out of every group (nothing to compare)
 * @returns { pages: [{ primary, keywords: [..] }],   keywords that should be ONE page (7+ shared), primary = highest volume
 *           clusters: [[primary,...]],               pages that belong to the same topic cluster (4-6 shared)
 *           links: [[primaryA, primaryB]],           pages that should link to each other (2-3 shared)
 *           skipped: [keyword] }
 */
export function clusterBySerp(keywords) {
  const usable = keywords.filter((k) => Array.isArray(k.urls) && k.urls.some((u) => normalizeSerpUrl(u)));
  const skipped = keywords.filter((k) => !usable.includes(k)).map((k) => k.keyword);

  const find = (parent, i) => { let r = i; while (parent[r] !== r) r = parent[r]; while (parent[i] !== r) { const n = parent[i]; parent[i] = r; i = n; } return r; };
  const union = (parent, i, j) => { const a = find(parent, i); const b = find(parent, j); if (a !== b) parent[b] = a; };
  const pageParent = usable.map((_, i) => i);
  const clusterParent = usable.map((_, i) => i);
  const pairs = [];
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const rel = relateKeywords(usable[i], usable[j]);
      if (rel.relation === RELATION.SAME_PAGE) { union(pageParent, i, j); union(clusterParent, i, j); }
      else if (rel.relation === RELATION.SAME_CLUSTER) union(clusterParent, i, j);
      pairs.push({ i, j, relation: rel.relation });
    }
  }

  const byRoot = (parent) => {
    const m = new Map();
    usable.forEach((k, i) => { const r = find(parent, i); (m.get(r) || m.set(r, []).get(r)).push(k); });
    return [...m.values()];
  };
  const primaryOf = (group) => [...group].sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0) || a.keyword.localeCompare(b.keyword))[0].keyword;
  const pages = byRoot(pageParent).map((group) => ({ primary: primaryOf(group), keywords: group.map((k) => k.keyword).sort() })).sort((a, b) => a.primary.localeCompare(b.primary));
  const pageOf = new Map(); pages.forEach((p) => p.keywords.forEach((k) => pageOf.set(k, p.primary)));

  const clusters = byRoot(clusterParent).map((group) => [...new Set(group.map((k) => pageOf.get(k.keyword)))].sort()).filter((c) => c.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
  const inCluster = new Map(); clusters.forEach((c, n) => c.forEach((p) => inCluster.set(p, n)));
  const linkSet = new Set();
  for (const { i, j, relation } of pairs) {
    if (relation !== RELATION.INTERLINK) continue;
    const pa = pageOf.get(usable[i].keyword); const pb = pageOf.get(usable[j].keyword);
    if (pa === pb || (inCluster.has(pa) && inCluster.get(pa) === inCluster.get(pb))) continue; // already together
    linkSet.add([pa, pb].sort().join('\u0000'));
  }
  const links = [...linkSet].map((s) => s.split('\u0000')).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return { pages, clusters, links, skipped };
}

/**
 * Pairs worth fetching results for, so a big keyword list does not cost N*(N-1)/2 lookups. Keywords are grouped by head term (their
 * first word, which is crude but cheap); every pair inside a group is compared, plus the highest-volume keyword of each group against
 * the other groups' tops. Callers cap the total.
 * @returns [[keywordA, keywordB]]
 */
export function pairsToCompare(keywords) {
  const head = (k) => String(k.keyword).toLowerCase().split(/\s+/)[0];
  const groups = new Map();
  for (const k of keywords) (groups.get(head(k)) || groups.set(head(k), []).get(head(k))).push(k);
  const pairs = [];
  for (const group of groups.values()) for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) pairs.push([group[i].keyword, group[j].keyword]);
  const tops = [...groups.values()].map((g) => [...g].sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))[0].keyword);
  for (let i = 0; i < tops.length; i += 1) for (let j = i + 1; j < tops.length; j += 1) pairs.push([tops[i], tops[j]]);
  return pairs;
}
