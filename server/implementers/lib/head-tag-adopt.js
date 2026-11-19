// ADOPTING existing head tags into a marker region, so a later fix replaces them instead of duplicating them.
//
// Some sites (an Eleventy site converted from static HTML) hard-code the Open Graph, Twitter and canonical tags in a per-page head file.
// A marker region added NEXT TO them would give two sets of tags the first time a fix writes into it, and a region wrapped around a run
// that also holds tags the generators never write (og:image, og:url, og:type, ...) would delete those on that same first fix. So:
//
//   canonical    the one existing `<link rel="canonical">` is wrapped in place. The generator rewrites exactly that tag.
//   openGraph    the five tags open-graph's generator writes (og:title, og:description, twitter:card, twitter:title, twitter:description)
//                are MOVED, unchanged and in their original order, into one region at the place of the first of them. Every other tag
//                stays where it was. Nothing is added, nothing is dropped, no value changes.
//
// Refuses rather than guesses: a tag that appears more than once, a tag already inside a marker, a JSX file, or nothing to adopt.
// setup-pr.js checks the result with sameLinesIgnoringOrder: the same lines, in any order, apart from the marker comments.

const OG_TAGS = [
  /<meta\s+property=["']og:title["'][^>]*>/gi,
  /<meta\s+property=["']og:description["'][^>]*>/gi,
  /<meta\s+name=["']twitter:card["'][^>]*>/gi,
  /<meta\s+name=["']twitter:title["'][^>]*>/gi,
  /<meta\s+name=["']twitter:description["'][^>]*>/gi,
];
const CANONICAL = /<link\b[^>]*\brel=["']canonical["'][^>]*>/gi;
const MARKER_TOKEN = /<!--\s*SEOAI:[\w-]+:(?:START|END)\s*-->|\{\/\*\s*SEOAI:[\w-]+:(?:START|END)\s*\*\/\}|[ \t]#[ \t]*SEOAI:[\w-]+/gi;

const spansOf = (content, re) => { const out = []; let m; re.lastIndex = 0; while ((m = re.exec(content))) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] }); return out; };
const lineStart = (content, i) => content.lastIndexOf('\n', i - 1) + 1;
const indentAt = (content, i) => (/^[ \t]*/.exec(content.slice(lineStart(content, i), i)) || [''])[0];

// Is this offset already inside a SEOAI block region? (then it is not ours to move)
function insideRegion(content, i) {
  const re = /<!--\s*SEOAI:([\w-]+):START\s*-->[\s\S]*?<!--\s*SEOAI:\1:END\s*-->/g; let m;
  while ((m = re.exec(content))) if (i >= m.index && i < m.index + m[0].length) return true;
  return false;
}

export function adoptHeadTags(content, field, markerName, filePath = '') {
  if (/\.(jsx|tsx)$/i.test(filePath)) return { ok: false, reason: 'jsx-not-supported' };
  if (field !== 'canonical' && field !== 'openGraph') return { ok: false, reason: 'not-adoptable' };
  const start = `<!-- SEOAI:${markerName}:START -->`; const end = `<!-- SEOAI:${markerName}:END -->`;

  if (field === 'canonical') {
    const found = spansOf(content, CANONICAL);
    if (found.length !== 1) return { ok: false, reason: found.length ? 'canonical-more-than-once' : 'nothing-to-adopt' };
    const [t] = found;
    if (insideRegion(content, t.start)) return { ok: false, reason: 'already-in-a-marker' };
    return { ok: true, content: content.slice(0, t.start) + start + t.text + end + content.slice(t.end), adopted: 1 };
  }

  const spans = [];
  for (const re of OG_TAGS) {
    const found = spansOf(content, re);
    if (found.length > 1) return { ok: false, reason: 'tag-more-than-once' };
    if (found.length === 1) spans.push(found[0]);
  }
  if (!spans.length) return { ok: false, reason: 'nothing-to-adopt' };
  if (spans.some((s) => insideRegion(content, s.start))) return { ok: false, reason: 'already-in-a-marker' };
  spans.sort((a, b) => a.start - b.start);

  const indent = indentAt(content, spans[0].start);
  const region = `${start}\n${spans.map((s) => `${indent}${s.text}`).join('\n')}\n${indent}${end}`;
  // Remove each moved tag together with the whitespace of the line it sat on, working from the end so earlier offsets stay valid.
  let out = content;
  for (const s of [...spans].reverse()) {
    let from = s.start; let to = s.end;
    const ls = lineStart(out, from);
    const before = out.slice(ls, from); const eol = out.indexOf('\n', to); const after = out.slice(to, eol === -1 ? out.length : eol);
    if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) { from = ls; to = eol === -1 ? out.length : eol + 1; }   // the tag was alone on its line: take the line
    out = out.slice(0, from) + out.slice(to);
  }
  // The region goes where the first tag was. Offsets before it were not touched by removals that happened after it, but the first tag's own
  // line was removed, so its line start is where the region now begins.
  const at = lineStart(content, spans[0].start);
  const insertAt = Math.min(at, out.length);
  out = out.slice(0, insertAt) + indent + region + '\n' + out.slice(insertAt);
  return { ok: true, content: out, adopted: spans.length };
}

// The same check one level finer, for heads whose tags share a line (a minified head: `<meta ...><meta ...><meta ...>`). Compared tag by tag
// (and text between tags), in any order, apart from the marker comments: a lost, duplicated or edited tag still fails; only the order of tags
// and where the line breaks fall are ignored. Used for head files only, where whitespace between tags means nothing.
export function sameTagsIgnoringOrder(before, after) {
  const tokens = (s) => (String(s).replace(MARKER_TOKEN, '').match(/<[^>]*>|[^<]+/g) || []).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).sort();
  const a = tokens(before); const b = tokens(after);
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

// The safety rule for an adoption: the same lines, in any order, once the marker comments are removed. A moved tag is the same line in a
// different place; a lost or duplicated tag changes the count and fails.
export function sameLinesIgnoringOrder(before, after) {
  const lines = (s) => String(s).replace(MARKER_TOKEN, '').split('\n').map((l) => l.trim()).filter(Boolean).sort();
  const a = lines(before); const b = lines(after);
  return a.length === b.length && a.every((l, i) => l === b[i]);
}
