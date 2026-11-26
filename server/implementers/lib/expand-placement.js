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

// `learned` is the site's own vocabulary ({ faq: RegExp|null, cta: RegExp|null } from section-signals.js): what THIS site calls those sections, used in addition to the generic words.
export function classifyBlock(text, roles, learned = null) {
  for (const role of roles) if (SIGNALS[role]?.test(text) || learned?.[role]?.test(text)) return role;
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
export function markupBlocks(text, roles, learned = null) {
  const out = [];
  const re = /<(section|aside|div|[A-Z][A-Za-z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[1]; const attrs = m[2] || '';
    const role = classifyBlock(`${tag} ${attrs}`, roles, learned) || (tag === 'section' || /^[A-Z]/.test(tag) ? classifyBlock(headingNear(text, m.index), roles, learned) : null);
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

function markdownBlocks(text, roles, learned = null) {
  const out = [];
  const re = /^#{2,3}[ \t]+(.+)$/gm;
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, role: classifyBlock(m[1], roles, learned), close: m.index });
  return out;
}

// A closing call to action, recognised by what it IS when no word names it: the LAST section before the marker, short, with a heading and a link or a button ("Your next step",
// a closing banner, a contact strip). Used only when no trailing FAQ/CTA was recognised by name, only for the very last section, and only when it closes (never one that
// encloses the marker), so a long content section or a section with nothing to click is never taken for one.
const CLOSING_CTA_MAX_TEXT = 400;
export function lastSectionIsClosingCta(text, blocks, markerOffset) {
  const last = blocks[blocks.length - 1];
  if (!last || last.tag !== 'section' || !Number.isFinite(last.close) || last.close > markerOffset) return null;
  const inner = text.slice(last.start, last.close);
  const visible = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!visible || visible.length > CLOSING_CTA_MAX_TEXT) return null;
  if (!/<h[1-4]\b/i.test(inner) || !/<(a|button)\b/i.test(inner)) return null;
  return last.start > 0 ? last.start : null;
}

/**
 * The offset at which the marker should sit, or null to leave it where it is.
 * `text` is the file WITHOUT the marker; `markerOffset` is where it was.
 */
export function placementOffset(text, markerOffset, { roles, markdown = false, signals = null }) {
  if (!roles?.length) return null;
  const all = (markdown ? markdownBlocks(text, roles, signals) : topLevel(markupBlocks(text, roles, signals)))
    .filter((b) => b.start < markerOffset);
  // A block still open at the marker's position ENCLOSES it. Placing relative
  // to something we are inside of would be a guess.
  if (all.some((b) => b.close > markerOffset)) {
    if (!markdown) return null;
  }
  let first = null;
  for (let i = all.length - 1; i >= 0 && all[i].role; i--) first = all[i];
  if (first) return first.start > 0 ? first.start : null;
  return markdown ? null : lastSectionIsClosingCta(text, all, markerOffset);
}

/**
 * Move a marker created in THIS call above the trailing FAQ/CTA run.
 * Returns { content, moved, reason }.
 */
export function refineMarkerPlacement(content, filePath, markerName, roles, { markerWasPresent = false, signals = null } = {}) {
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
  const at = placementOffset(without, cutStart, { roles, markdown, signals });
  if (at == null) return { content, moved: false, reason: 'no-trailing-faq-or-cta' };

  return { content: `${without.slice(0, at)}\n${block}\n${without.slice(at)}`, moved: true, reason: 'before-trailing-sections', offset: at };
}

/**
 * Where RELATED GUIDES go: after the FAQ and before the final call to action.
 *  - trailing run has a CTA            -> just before the CTA (so after any FAQ in front of it)
 *  - trailing run is only an FAQ       -> just after that FAQ
 *  - no trailing FAQ or CTA            -> null (leave where the engine put it)
 * `text` is the file WITHOUT the marker; `markerOffset` is where it was. Never invents a position, and gives up when the marker sits inside a block.
 */
export function relatedGuidesOffset(text, markerOffset, { markdown = false, signals = null } = {}) {
  if (markdown) return null; // a markdown page has no sections to order against; leave the marker where it is
  const roles = ['faq', 'cta'];
  const all = topLevel(markupBlocks(text, roles, signals)).filter((b) => b.start < markerOffset);
  if (all.some((b) => b.close > markerOffset)) return null; // inside a block: placing relative to it would be a guess
  const run = [];
  for (let i = all.length - 1; i >= 0 && all[i].role; i--) run.unshift(all[i]);
  if (!run.length) return lastSectionIsClosingCta(text, all, markerOffset);
  const cta = run.find((b) => b.role === 'cta');
  if (cta) return cta.start > 0 ? cta.start : null;
  const faq = run[run.length - 1]; // only FAQ blocks in the run: go after the last one
  return Number.isFinite(faq.close) && faq.close > 0 && faq.close <= markerOffset ? faq.close : null;
}

/** Move a related-guides marker created in THIS call to its place in the standard order. Same safety rules as refineMarkerPlacement. */
export function refineRelatedGuidesPlacement(content, filePath, markerName, { markerWasPresent = false, signals = null } = {}) {
  if (markerWasPresent) return { content, moved: false, reason: 'marker-already-on-page' };
  const pats = markerPattern(markerName);
  const found = pats.jsx.exec(content) || pats.html.exec(content);
  if (!found) return { content, moved: false, reason: 'marker-not-found' };
  const block = found[0];
  let cutStart = found.index;
  if (content[cutStart - 1] === '\n') cutStart -= 1;
  const without = content.slice(0, cutStart) + content.slice(found.index + block.length).replace(/^\n/, '');
  const at = relatedGuidesOffset(without, cutStart, { markdown: /\.mdx?$/i.test(filePath || ''), signals });
  if (at == null) return { content, moved: false, reason: 'no-trailing-faq-or-cta' };
  return { content: `${without.slice(0, at)}\n${block}\n${without.slice(at)}`, moved: true, reason: 'after-faq-before-cta', offset: at };
}
