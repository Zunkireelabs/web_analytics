// Where on an EXISTING page a newly created expand-content marker goes.
//
// The insertion engine puts a body marker at the end of the page's detected
// content container. For a page that closes with an FAQ and a call-to-action,
// that is AFTER them — the expanded content lands below the CTA, which no
// well-structured site does. The structure reference (design-agent/lib/
// expand-structure-spec.js) carries the rule: after the last content section,
// before the FAQ/CTA that follow it. This module applies that rule to a marker
// the engine has already created at the container's end, by moving it up
// above the trailing run of FAQ/CTA sections.
//
// Pure string work, no repo or database. It never invents a position: when it
// cannot positively identify a trailing FAQ/CTA run it leaves the marker
// exactly where the engine put it, and it only ever moves a marker created in
// the SAME call — a marker already on the page was placed deliberately (by a
// person, or a previous run) and is not touched.

// Heading/attribute signals per role. Deliberately specific: a false positive
// moves content above something that was not an FAQ or CTA.
const SIGNALS = {
  faq: /\bfaqs?\b|frequently[\s-]*asked|common[\s-]*questions|questions?[\s-]*(and|&)[\s-]*answers?/i,
  cta: /\bcta\b|call[\s-]*to[\s-]*action|get[\s-]*started|get[\s-]*in[\s-]*touch|contact[\s-]*us|book[\s-]*(a|your)\b|request[\s-]*(a|your)\b|ready[\s-]*to\b|free[\s-]*(trial|consultation|quote)/i,
};

export function classifyBlock(text, roles) {
  for (const role of roles) if (SIGNALS[role]?.test(text)) return role;
  return null;
}

const markerPattern = (name) => ({
  jsx: new RegExp(`\\{/\\*\\s*SEOAI:${name}:START\\s*\\*/\\}[\\s\\S]*?\\{/\\*\\s*SEOAI:${name}:END\\s*\\*/\\}`),
  html: new RegExp(`<!--\\s*SEOAI:${name}:START\\s*-->[\\s\\S]*?<!--\\s*SEOAI:${name}:END\\s*-->`),
});

// Where an element opened at `start` closes, or Infinity when it never does
// before the end of the text (it encloses whatever follows). Self-closing tags
// close immediately.
function closeOffset(text, start, tag) {
  const openEnd = text.indexOf('>', start);
  if (openEnd === -1) return Infinity;
  if (text[openEnd - 1] === '/') return openEnd + 1;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'g');
  re.lastIndex = start;
  let depth = 0; let m;
  while ((m = re.exec(text))) {
    if (m[2] === '/' ) continue; // a nested self-closing tag of the same name
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return Infinity;
}

const headingNear = (text, from) => {
  const m = text.slice(from, from + 700).match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
  return m ? m[1].replace(/<[^>]+>/g, ' ') : '';
};

// Section-like blocks in markup (HTML / templates / JSX), each classified by
// its own attributes and first heading. <section> always counts as a block;
// a div/aside/component counts only when it positively matches a role, so
// ordinary wrappers never become fake boundaries.
export function markupBlocks(text, roles) {
  const out = [];
  const re = /<(section|aside|div|[A-Z][A-Za-z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[1]; const attrs = m[2] || '';
    const role = classifyBlock(`${tag} ${attrs}`, roles) || (tag === 'section' || /^[A-Z]/.test(tag) ? classifyBlock(headingNear(text, m.index), roles) : null);
    if (tag !== 'section' && !role) continue;
    out.push({ start: m.index, tag, role: role || null, close: closeOffset(text, m.index, tag) });
  }
  return out;
}

// Only blocks not nested inside an earlier one: a FAQ accordion inside the
// content section is part of that section, not a trailing section of its own.
function topLevel(blocks) {
  const kept = []; let until = -1;
  for (const b of blocks) {
    if (b.start < until) continue;
    kept.push(b);
    until = b.close;
  }
  return kept;
}

function markdownBlocks(text, roles) {
  const out = [];
  const re = /^#{2,3}[ \t]+(.+)$/gm;
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, role: classifyBlock(m[1], roles), close: m.index });
  return out;
}

/**
 * The offset at which the marker should sit, or null to leave it where it is.
 * `text` is the file WITHOUT the marker; `markerOffset` is where it was.
 */
export function placementOffset(text, markerOffset, { roles, markdown = false }) {
  if (!roles?.length) return null;
  const all = (markdown ? markdownBlocks(text, roles) : topLevel(markupBlocks(text, roles)))
    .filter((b) => b.start < markerOffset);
  // A block still open at the marker's position ENCLOSES it. Placing relative
  // to something we are inside of would be a guess.
  if (all.some((b) => b.close > markerOffset)) {
    if (!markdown) return null;
  }
  let first = null;
  for (let i = all.length - 1; i >= 0 && all[i].role; i--) first = all[i];
  return first && first.start > 0 ? first.start : null;
}

/**
 * Move a marker created in THIS call above the trailing FAQ/CTA run.
 * Returns { content, moved, reason }.
 */
export function refineMarkerPlacement(content, filePath, markerName, roles, { markerWasPresent = false } = {}) {
  if (markerWasPresent) return { content, moved: false, reason: 'marker-already-on-page' };
  const pats = markerPattern(markerName);
  const found = pats.jsx.exec(content) || pats.html.exec(content);
  if (!found) return { content, moved: false, reason: 'marker-not-found' };

  const block = found[0];
  let cutStart = found.index;
  // Take the newline the engine added in front of it, so removal and
  // reinsertion are symmetric and no blank-line drift accumulates.
  if (content[cutStart - 1] === '\n') cutStart -= 1;
  const without = content.slice(0, cutStart) + content.slice(found.index + block.length).replace(/^\n/, '');

  const markdown = /\.mdx?$/i.test(filePath || '');
  const at = placementOffset(without, cutStart, { roles, markdown });
  if (at == null) return { content, moved: false, reason: 'no-trailing-faq-or-cta' };

  return { content: `${without.slice(0, at)}\n${block}\n${without.slice(at)}`, moved: true, reason: 'before-trailing-sections', offset: at };
}
