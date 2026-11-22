// Pure matchers for "did this change actually land?", used both BEFORE approval (against the file the draft is about to write)
// and AFTER deploy (against the live HTML). Every one of them checks the thing the generator really ships:
//   internal-links  -> a link to the target URL whose text is the anchor (NOT the model's rationale sentence)
//   schema-repair   -> the structured data's actual state (parses / no longer duplicated), NOT a slice of serialized JSON
//   meta-title      -> the chosen <title> and meta description, compared after entity/escape/whitespace normalisation
// They never pass on unrelated text: a link needs BOTH the right target and the right anchor, a schema check needs real JSON-LD
// parsed, a meta check needs the whole title and the whole description. Where the content simply cannot answer (a templated
// source with no parseable block), they return present:null ("cannot tell"), never true.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...' };

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}

// One normal form for comparing text that may have travelled through HTML, JSX, JS string literals or markdown.
export function normalizeForMatch(s) {
  return decodeEntities(s)
    .replace(/\\(['"`])/g, '$1')                 // JS/JSON string escapes: it\'s -> it's
    .replace(/\\n|\\t/g, ' ')
    .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/ /g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

const stripTags = (html) => String(html ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ');

// ── links ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
function normHref(href, origin) {
  let h = decodeEntities(String(href || '').trim()).replace(/[#?].*$/, '');
  if (origin && h.toLowerCase().startsWith(origin.toLowerCase())) h = h.slice(origin.length) || '/';
  h = h.replace(/^https?:\/\/(www\.)?/i, '//').replace(/\/+$/, '');
  return h.toLowerCase();
}

export function extractLinks(source) {
  const out = [];
  const text = String(source ?? '');
  // <a ... href="x" ...>text</a>   (also href='x' and JSX href={"x"})
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(text))) {
    const attr = /\bhref\s*=\s*(?:\{\s*)?(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/i.exec(m[1]);
    if (attr) out.push({ href: attr[1] ?? attr[2] ?? attr[3], text: normalizeForMatch(stripTags(m[2])) });
  }
  // markdown [text](x)
  const mdRe = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((m = mdRe.exec(text))) out.push({ href: m[2], text: normalizeForMatch(m[1]) });
  return out;
}

/** expected: { links: [{ href, anchor }], origin? } — at least one suggested (target, anchor) pair must exist as a real link. */
export function matchLinksPresent(content, expected) {
  const wanted = (expected?.links || []).filter((l) => l?.href && l?.anchor);
  if (!wanted.length) return { present: null, evidence: { error: 'no link target and anchor were recorded for this change' } };
  const have = extractLinks(content);
  const hits = wanted.filter((w) => have.some((h) => normHref(h.href, expected.origin) === normHref(w.href, expected.origin) && h.text.includes(normalizeForMatch(w.anchor))));
  return { present: hits.length > 0, evidence: { suggested: wanted.length, found: hits.length, missing: wanted.filter((w) => !hits.includes(w)).map((w) => ({ href: w.href, anchor: w.anchor })).slice(0, 5) } };
}

// ── structured data ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function parseLdJsonBlocks(content) {
  const blocks = []; const failures = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(content ?? '')))) {
    const raw = m[1].trim();
    if (!raw) { failures.push(raw); continue; }
    try { blocks.push(JSON.parse(raw)); } catch { failures.push(raw); }
  }
  return { blocks, failures };
}

const typesOf = (node) => {
  const t = node?.['@type'];
  return (Array.isArray(t) ? t : t ? [t] : []).map(String);
};
// every typed node in a block, including @graph members
function typedNodes(block) {
  const nodes = [];
  const walk = (n) => { if (n && typeof n === 'object') { if (Array.isArray(n)) n.forEach(walk); else { if (n['@type']) nodes.push(n); if (Array.isArray(n['@graph'])) n['@graph'].forEach(walk); } } };
  walk(block);
  return nodes;
}
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * expected: { fixType: 'remove-duplicate', duplicateType, originalRaw } or { fixType: 'repair-malformed', jsonLd }
 * Judged on the structured data itself. A source file that holds no parseable JSON-LD (a template) gives present:null.
 */
export function matchSchemaState(content, expected) {
  const { blocks, failures } = parseLdJsonBlocks(content);
  if (expected?.fixType === 'remove-duplicate') {
    const type = expected.duplicateType;
    if (!type) return { present: null, evidence: { error: 'no duplicate type was recorded' } };
    if (!blocks.length && !failures.length) {
      // Nothing parseable here (templated source): the one thing that CAN be said is whether the removed block is still in the text.
      const raw = normalizeForMatch(expected.originalRaw || '');
      if (!raw) return { present: null, evidence: { error: 'no block text was recorded' } };
      return { present: !normalizeForMatch(content).includes(raw), evidence: { duplicateType: type, check: 'removed block no longer in the file' } };
    }
    const count = blocks.reduce((n, b) => n + typedNodes(b).filter((x) => typesOf(x).includes(type)).length, 0);
    return { present: count === 1, evidence: { duplicateType: type, remaining: count, expected: 1, unparseableBlocks: failures.length } };
  }
  if (expected?.fixType === 'repair-malformed') {
    if (!blocks.length && !failures.length) return { present: null, evidence: { error: 'this file holds no JSON-LD block to inspect' } };
    const repaired = expected.jsonLd ? blocks.some((b) => deepEqual(b, expected.jsonLd)) : null;
    return { present: failures.length === 0 && repaired !== false, evidence: { unparseableBlocks: failures.length, repairedBlockPresent: repaired } };
  }
  return { present: null, evidence: { error: 'unknown schema fix type' } };
}

// ── title and meta description ──────────────────────────────────────────────────────────────────────────────────────────
/** expected: { title?, description? } — each given field must appear WHOLE (after normalisation); a missing field is not checked. */
export function matchMetaTags(content, expected) {
  const title = normalizeForMatch(expected?.title);
  const description = normalizeForMatch(expected?.description);
  if (!title && !description) return { present: null, evidence: { error: 'no title or description was recorded' } };
  const text = String(content ?? '');
  // Live HTML has the real tags, so compare against THOSE (the phrase appearing somewhere in the body proves nothing). A source
  // file (JSX, markdown front matter, a template) has no such tags, so there the whole file is the haystack.
  const tagTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
  const tagDesc = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(text)?.[0];
  const descContent = tagDesc ? (/\bcontent\s*=\s*"([^"]*)"/i.exec(tagDesc)?.[1] ?? /\bcontent\s*=\s*'([^']*)'/i.exec(tagDesc)?.[1]) : undefined;
  const whole = normalizeForMatch(text);
  const titleOk = title ? (tagTitle !== undefined ? normalizeForMatch(tagTitle).includes(title) : whole.includes(title)) : true;
  const descOk = description ? (descContent !== undefined ? normalizeForMatch(descContent).includes(description) : whole.includes(description)) : true;
  return { present: titleOk && descOk, evidence: { titleFound: title ? titleOk : null, descriptionFound: description ? descOk : null, comparedAgainst: tagTitle !== undefined || descContent !== undefined ? 'live tags' : 'file text' } };
}
