// Pure helpers shared by the content index, the evidence gate and topic research: one definition of "the same URL" and "the same topic",
// so the three can never disagree about whether something already exists.
import { topicTokens, topicKey } from '../../agents/lib/keyword-coverage.js';

export { topicTokens, topicKey };

/** Normalised identity of a page URL: host without www, lower-case path without trailing slash, no query or hash. Language prefixes stay. */
export function urlKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${path === '/' ? '' : path}`;
  } catch { return null; }
}

/** Path of a URL (or of a bare path) in the same normal form, e.g. "/blog/post". */
export function pathKey(urlOrPath) {
  const s = String(urlOrPath || '');
  try { return (new URL(s, 'https://x.invalid').pathname.replace(/\/+$/, '').toLowerCase()) || '/'; } catch { return null; }
}

/** The words that identify a page or a draft: its title and the slug of its URL or file. */
export function tokensForEntry({ title = '', url = '', filePath = '' } = {}) {
  const slug = (pathKey(url) || '').split('/').pop() || '';
  const fileSlug = String(filePath || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '');
  return [...new Set([...topicTokens(title), ...topicTokens(slug.replace(/[-_]+/g, ' ')), ...topicTokens(fileSlug.replace(/[-_]+/g, ' '))])];
}

const containment = (a, b) => { if (!a.length) return 0; const s = new Set(b); return a.filter((t) => s.has(t)).length / a.length; };
const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); const inter = [...A].filter((t) => B.has(t)).length; const uni = new Set([...A, ...B]).size; return uni ? inter / uni : 0; };

/**
 * How strongly a topic matches something already in the index. 'exact' = the same topic words; 'near' = strong overlap in both directions,
 * or a topic of three or more words fully inside the entry. A single shared word is never a match. Returns { match, kind, score }.
 */
export function topicMatch(topicTokenList, entryTokenList) {
  if (!topicTokenList.length || !entryTokenList.length) return { match: false, kind: null, score: 0 };
  const a = [...topicTokenList].sort().join(' '); const b = [...entryTokenList].sort().join(' ');
  if (a === b) return { match: true, kind: 'exact', score: 1 };
  const j = jaccard(topicTokenList, entryTokenList); const c = containment(topicTokenList, entryTokenList);
  if (topicTokenList.length >= 2 && j >= 0.6) return { match: true, kind: 'near', score: Math.round(j * 100) / 100 };
  if (topicTokenList.length >= 3 && c >= 0.9) return { match: true, kind: 'near', score: Math.round(c * 100) / 100 };
  return { match: false, kind: null, score: Math.round(Math.max(j, c * 0.8) * 100) / 100 };
}

/** Share of the topic's words found in a ranking query (for the cannibalisation check). */
export const queryContainment = (topicTokenList, query) => containment(topicTokenList, topicTokens(query));
