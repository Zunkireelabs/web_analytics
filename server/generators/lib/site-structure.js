// What the site really contains, from its own page inventory (the sitemap and crawl), for the blog-outline prompt. Two jobs:
//  1. Internal-link candidates that are on topic. Until now the candidates were only the 20 pages with the most search traffic, so a
//     relevant page nobody searches for yet (the very pages that need links) could never be linked.
//  2. A plain list of the site's real sections, so the post can only talk about offerings the site actually has.
// The ideas are claude-seo's content-brief rules (MIT, (c) 2026 agricidaniel; skill by puneetindersingh): a "Website Relevance Rule"
// (every suggestion must be something the site can credibly deliver) and a "Site Structure Coverage Rule" (a hub or overview post must
// cover every relevant page that exists, and not invent categories that do not). Pure: rows in, lists out.

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'with', 'how', 'what', 'why', 'is', 'are', 'your', 'you', 'best', 'top', 'guide', 'vs', 'about', 'new', 'from', 'by', 'at', 'do', 'does', 'can', 'it', 'its']);
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
const stem = (t) => t.replace(/(ing|ies|es|s|ed)$/, '');
const pathOf = (url) => { try { return new URL(url).pathname; } catch { return ''; } };

/**
 * Inventory pages whose address shares a meaningful word with the topic, best match first.
 * @param rows        page_inventory rows ({ page, orphaned })
 * @param exclude     URLs already candidates
 */
export function topicalPages(rows, topic, { exclude = new Set(), limit = 10 } = {}) {
  const want = new Set(tokens(topic).map(stem));
  if (!want.size) return [];
  const scored = [];
  for (const r of rows || []) {
    const page = r?.page;
    if (!page || r.orphaned || exclude.has(page)) continue;
    const path = pathOf(page);
    if (!path || path === '/') continue;
    const have = new Set(tokens(path).map(stem));
    let hits = 0; for (const w of want) if (have.has(w)) hits += 1;
    if (hits > 0) scored.push({ page, hits, depth: path.split('/').filter(Boolean).length });
  }
  return scored.sort((a, b) => b.hits - a.hits || a.depth - b.depth || a.page.localeCompare(b.page)).slice(0, limit).map((s) => s.page);
}

/** "/services/ (12 pages), /pricing/ (1 page)": the first path segment of every real page, biggest first. */
export function siteSections(rows, { limit = 12 } = {}) {
  const counts = new Map();
  for (const r of rows || []) {
    if (!r?.page || r.orphaned) continue;
    const seg = pathOf(r.page).split('/').filter(Boolean)[0];
    if (!seg) continue;
    counts.set(`/${seg}/`, (counts.get(`/${seg}/`) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
    .map(([path, n]) => `${path} (${n} page${n === 1 ? '' : 's'})`);
}

// "Types of X", "complete guide to Y services", "all our options": a post whose job is to point at the site's own pages.
const HUB_RE = /\b(types of|kinds of|all (the )?(types|kinds|options|services)|overview|services?|options|ways to|ultimate guide|complete guide)\b/i;
export const looksLikeHub = (topic) => HUB_RE.test(String(topic || ''));

/** The prompt block: real sections, plus the two brief rules. '' when the site has nothing recorded (the prompt stays as it was). */
export function structurePrompt({ sections, topical, topic }) {
  if (!sections?.length && !topical?.length) return '';
  const lines = [];
  if (sections?.length) lines.push(`This site's real sections (from its own sitemap): ${sections.join(', ')}. Only describe services, products or offerings this site actually has; a topic the site does not cover can still be written about in general terms, but never as something this business provides.`);
  if (topical?.length && looksLikeHub(topic)) lines.push(`This is an overview post. Give each relevant existing page from the internal link candidates its own short section with an inline link, so the post covers everything the site has on the topic. Do not invent categories or pages the site does not have.`);
  return lines.join('\n');
}
