// A client's own written content rules (docs/seo-content-rules.md in ITS repo), applied to the posts written for it.
//
// Why: Admizz's repo fails its Build on British spelling, "Nepalese", day-first dates and long meta titles, and nothing in this
// platform knew those rules, so 23 posts were written, passed our gate and then failed the client's. The rules live with each client,
// so they are read from the client's repo, never hardcoded per client, and one client's rules never touch another's posts
// (multi-tenant rule). A repo with no such file gets null and everything stays exactly as it was.

import { getFileContent } from '../../github/client.js';

export const RULES_PATH = 'docs/seo-content-rules.md';

// British -> American, the words the Admizz validator rejects plus the near relatives of each.
const AMERICAN = [
  ['counsellors', 'counselors'], ['counsellor', 'counselor'], ['counselling', 'counseling'], ['counselled', 'counseled'],
  ['recognising', 'recognizing'], ['recognised', 'recognized'], ['recognise', 'recognize'],
  ['personalised', 'personalized'], ['personalise', 'personalize'], ['customised', 'customized'], ['customise', 'customize'],
  ['organising', 'organizing'], ['organised', 'organized'], ['organise', 'organize'],
  ['specialised', 'specialized'], ['specialise', 'specialize'],
  ['programmes', 'programs'], ['programme', 'program'], ['enrolments', 'enrollments'], ['enrolment', 'enrollment'],
  ['centres', 'centers'], ['centre', 'center'], ['advisers', 'advisors'], ['adviser', 'advisor'],
  ['practise', 'practice'], ['travelling', 'traveling'],
];

// Official names keep their own spelling.
const OFFICIAL = /Confirmation of Enrolment|sponsor licence|Visa Application Centre|Orange Knowledge Programme|honours degree/gi;
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const SKIP_KEYS = new Set(['url', 'slug', 'targetUrl', 'href', 'path', 'groundingContext', 'topic', 'publishedAt', 'categories', 'suggestedFaqTopics']);
// What must never be rewritten: markdown link targets, absolute URLs and site paths.
const PROTECT = new RegExp(`${OFFICIAL.source}|\\]\\([^)]*\\)|https?:\\/\\/[^\\s"')]+|\\/[a-z0-9][a-z0-9\\-_\\/.]*`, 'gi');

/** Reads the rules text and returns what can be enforced mechanically, or null when it asks for nothing we can enforce. */
export function parseStyleRules(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const american = /american\s+(english|spelling)/i.test(t);
  // "Nepali" (not "Nepalese")  ->  Nepalese becomes Nepali.
  const swaps = [];
  for (const m of t.matchAll(/"([A-Za-z][\w -]{1,30})"\s*\(\s*not\s*"([A-Za-z][\w -]{1,30})"\s*\)/g)) swaps.push([m[2], m[1]]);
  const monthFirst = /month-first/i.test(t);
  const tm = t.match(/title\s+(?:under|below|of at most)\s+(?:about\s+)?(\d{2})\b/i);
  const titleMax = tm ? Number(tm[1]) + 5 : null; // the clients' validators allow a little above the guideline
  if (!american && !swaps.length && !monthFirst && !titleMax) return null;
  return { american, swaps, monthFirst, titleMax, text: t };
}

const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

/** `strict` (the ship step): a failed read throws instead of meaning "no rules", so a post is never written unchecked because GitHub hiccuped. A failed read is never cached either way. */
export async function loadSiteStyleRules(site, { fetchFile = getFileContent, now = Date.now(), strict = false } = {}) {
  if (!site?.id) return null;
  const hit = cache.get(site?.id);
  if (hit && now - hit.at < TTL_MS) return hit.rules;
  let rules = null;
  try {
    const file = await fetchFile(site, RULES_PATH, (site.repo_default_branch || 'main'));
    rules = file?.content ? parseStyleRules(file.content) : null;
  } catch (err) {
    if (strict) throw err;
    return null; // best effort when only a draft is being written; not cached
  }
  cache.set(site?.id, { at: now, rules });
  return rules;
}
export function clearSiteStyleRulesCache() { cache.clear(); }

function caseLike(src, rep) {
  if (src.length > 1 && src === src.toUpperCase()) return rep.toUpperCase();
  return src[0] === src[0].toUpperCase() ? rep[0].toUpperCase() + rep.slice(1) : rep;
}

/** One visible string, rewritten to the rules. */
export function applyToText(s, rules) {
  if (!rules || typeof s !== 'string' || !s) return s;
  const kept = [];
  let t = s.replace(PROTECT, (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; });
  const pairs = [...(rules.american ? AMERICAN : []), ...(rules.swaps || [])];
  if (pairs.length) {
    const map = new Map(pairs.map(([a, b]) => [a.toLowerCase(), b]));
    const re = new RegExp(`\\b(${pairs.map(([a]) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
    t = t.replace(re, (m) => caseLike(m, map.get(m.toLowerCase())));
  }
  if (rules.monthFirst) t = t.replace(new RegExp(`(?<![\\w-])(\\d{1,2}) (${MONTHS})\\b`, 'g'), (m, d, mo) => `${mo} ${d}`);
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[Number(i)]);
}

function walk(v, rules, key) {
  if (typeof v === 'string') return SKIP_KEYS.has(key) ? v : applyToText(v, rules);
  if (Array.isArray(v)) return v.map((x) => walk(x, rules, key));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], rules, k); return o; }
  return v;
}

function trimTitle(title, max) {
  const t = String(title || '').trim();
  if (!max || t.length <= max) return t;
  // Cut at a word boundary, never mid-word, and never leave a dangling joiner.
  const cut = t.slice(0, max + 1).replace(/\s+\S*$/, '').replace(/[\s,:;|&-]+$/, '').replace(/\s+(and|or|the|of|to|for|a|in|on|with)$/i, '');
  return cut;
}

/** The whole draft content, normalized. The H1 (`title`) is shortened only when it would also be the meta title (no separate metaTitle). */
export function normalizeContent(content, rules, { shortenTitle = true } = {}) {
  if (!rules || !content || typeof content !== 'object') return content;
  const out = walk(content, rules, '');
  if (shortenTitle && rules.titleMax && typeof out.title === 'string') out.title = trimTitle(out.title, rules.titleMax);
  return out;
}

/** What is still wrong after normalizing, for the ship-time check: an empty list means the client's Build will accept the wording. */
export function styleViolations(content, rules) {
  if (!rules || !content) return [];
  const problems = [];
  if (rules.titleMax && String(content.title || '').length > rules.titleMax) problems.push(`title is ${content.title.length} characters (limit ${rules.titleMax})`);
  const after = JSON.stringify(walk(content, rules, ''));
  if (after !== JSON.stringify(content)) problems.push('uses wording the site\'s content rules forbid (British spelling, a banned term or a day-first date)');
  return problems;
}

/** Prompt lines so the model writes it right the first time. Empty when the site has no enforceable rules. */
export function styleRulesPrompt(rules) {
  if (!rules) return '';
  const parts = [];
  if (rules.american) parts.push('Write in American English (counselor, program, enrollment, recognize, organize, personalize, center, advisor).');
  for (const [from, to] of rules.swaps || []) parts.push(`Write "${to}", never "${from}", in visible text.`);
  if (rules.monthFirst) parts.push('Write dates month-first, for example "November 30, 2026".');
  if (rules.titleMax) parts.push(`Keep the title to ${rules.titleMax - 5} characters or fewer.`);
  return parts.length ? `This site's own content rules: ${parts.join(' ')} ` : '';
}
