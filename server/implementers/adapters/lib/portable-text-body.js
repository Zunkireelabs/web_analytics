import crypto from 'node:crypto';

// PURE helpers for adding body sections to a post that is stored as Portable Text JSON (admizz-web-dev: src/content/blog/posts/<slug>.json, a `content`
// array of blocks rendered by src/components/PortableTextRenderer.tsx). Nothing here touches the network; the adapter feeds it real files.
//
// THE RULE THAT KEEPS THE DESIGN SAFE: a block is written only if the site's OWN renderer is known to draw it. What the renderer draws is read from its source
// (rendererCapabilities), never assumed. A table is written only as the site's own table markup, taken from tables its existing posts already contain
// (inferTableMarkup: Admizz posts hold `<div class="table-scroll"><table class="elig-table">` inside a rawHtml block, styled by its shared stylesheet).
// Anything the renderer cannot draw is REFUSED with a reason, never approximated.

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// What the renderer draws

function matchingBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Keys written at the top level of an object literal property, e.g. sectionKeys(src, 'block') -> ['h2','h3','normal', ...]. */
export function sectionKeys(src, name) {
  const re = new RegExp(`(?:^|[\\s,{])${name}\\s*:\\s*\\{`, 'm');
  const m = re.exec(src);
  if (!m) return [];
  const open = src.indexOf('{', m.index + m[0].length - 1);
  const close = matchingBrace(src, open);
  if (close < 0) return [];
  const body = src.slice(open + 1, close);
  const keys = []; let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0) {
      const km = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      if (km && (i === 0 || /[\s,]/.test(body[i - 1]))) { keys.push(km[1]); i += km[0].length - 1; }
    }
  }
  return keys;
}

/** @returns {{ blockStyles:Set<string>, listTypes:Set<string>, listItems:Set<string>, marks:Set<string>, types:Set<string> }} */
export function rendererCapabilities(source) {
  const src = String(source || '');
  return {
    blockStyles: new Set(sectionKeys(src, 'block')),
    listTypes: new Set(sectionKeys(src, 'list')),
    listItems: new Set(sectionKeys(src, 'listItem')),
    marks: new Set(sectionKeys(src, 'marks')),
    types: new Set(sectionKeys(src, 'types')),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The site's own table markup

const TABLE_RE = /<div class="([^"]*table[^"]*)">\s*<table class="([^"]+)">/g;

/**
 * Looks at the raw-HTML blocks of the posts the site ALREADY has and returns the table markup they use most:
 * { wrapperClass, tableClass, posts } or null. Needs the same markup in at least 3 posts: one post is not a convention.
 * @param {string[]} htmlBlocks every rawHtml `html` string found in existing posts (one entry per post is enough)
 */
export function inferTableMarkup(htmlBlocks) {
  const votes = new Map();
  for (const html of htmlBlocks) {
    const seen = new Set();
    for (const m of String(html || '').matchAll(TABLE_RE)) seen.add(`${m[1]}|${m[2]}`);
    for (const k of seen) votes.set(k, (votes.get(k) || 0) + 1);
  }
  let best = null; let n = 0;
  for (const [k, c] of votes) if (c > n) { best = k; n = c; }
  if (!best || n < 3) return null;
  const [wrapperClass, tableClass] = best.split('|');
  return { wrapperClass, tableClass, posts: n };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const humanize = (k) => { const t = String(k).replace(/[_-]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Pure. Rows are the generator's structured table: an array of plain objects sharing the first row's keys. Never HTML, never markdown. */
export function tableHtml(rows, markup) {
  const cols = Object.keys(rows[0]);
  const head = `<thead><tr>${cols.map((c) => `<th>${esc(humanize(c))}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<div class="${markup.wrapperClass}"><table class="${markup.tableClass}">${head}${body}</table></div>`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Text to blocks

/** A block key in the site's own shape (12 hex characters), starting "aix" so every AI-written block can be recognised and removed again. */
export const newAiKey = () => `aix${crypto.randomBytes(5).toString('hex').slice(0, 9)}`;
export const isAiKey = (k) => typeof k === 'string' && /^aix[0-9a-f]{9}$/.test(k);

const INLINE = /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
const isExternal = (href) => /^https?:\/\//i.test(href);

/** Pure. Markdown-ish inline text to { children, markDefs } in the site's block shape. Links: external open in a new tab, internal do not (as in its own posts). */
export function inlineToSpans(text, newKey = newAiKey) {
  const children = []; const markDefs = [];
  const push = (t, marks = []) => { if (t) children.push({ _key: newKey(), _type: 'span', marks, text: t }); };
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    push(text.slice(last, m.index));
    if (m[1]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(m[1]);
      const def = { _key: newKey(), _type: 'link', blank: isExternal(href), href };
      markDefs.push(def); push(label, [def._key]);
    } else if (m[2]) push(m[2].slice(2, -2), ['strong']);
    else push(m[3].slice(1, -1), ['em']);
    last = m.index + m[0].length;
  }
  push(String(text).slice(last));
  if (!children.length) push('');
  return { children, markDefs };
}

const textBlock = (text, { style = 'normal', listItem = null, newKey }) => {
  const { children, markDefs } = inlineToSpans(text, newKey);
  return { _key: newKey(), _type: 'block', children, ...(listItem ? { level: 1, listItem } : {}), markDefs, style };
};

/**
 * Pure. One generated section ({heading, body, table?}) to blocks. Returns { ok:true, blocks } or { ok:false, reason, error }; a section the renderer cannot draw is refused.
 */
export function sectionToBlocks(section, { capabilities, tableMarkup = null, newKey = newAiKey } = {}) {
  const need = (cond, reason, error) => (cond ? null : { ok: false, reason, error });
  const caps = capabilities;
  const heading = String(section?.heading ?? '').trim();
  if (!heading) return { ok: false, reason: 'draft-not-ready', error: 'A section has no heading.' };
  const bad = need(caps.blockStyles.has('h2') && caps.blockStyles.has('normal'), 'renderer-cannot-draw', 'The site\'s renderer does not draw h2 headings and paragraphs.');
  if (bad) return bad;
  const blocks = [textBlock(heading, { style: 'h2', newKey })];

  const lines = String(section.body ?? '').split(/\r?\n/);
  let para = [];
  const flush = () => { if (para.length) { blocks.push(textBlock(para.join(' ').trim(), { newKey })); para = []; } };
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line); const number = /^\d+[.)]\s+(.*)$/.exec(line);
    if (!line) { flush(); continue; }
    if (bullet || number) {
      flush();
      const kind = bullet ? 'bullet' : 'number';
      const miss = need(caps.listItems.has(kind) && caps.listTypes.has(kind), 'renderer-cannot-draw', `The site's renderer does not draw ${kind} lists.`);
      if (miss) return miss;
      blocks.push(textBlock((bullet || number)[1], { listItem: kind, newKey }));
    } else para.push(line);
  }
  flush();
  if (blocks.some((b) => b.markDefs?.length)) {
    const miss = need(caps.marks.has('link'), 'renderer-cannot-draw', 'The site\'s renderer does not draw links.');
    if (miss) return miss;
  }

  if (Array.isArray(section.table) && section.table.length) {
    if (!tableMarkup) return { ok: false, reason: 'no-table-design', error: 'This draft has a table, but no table design of this site was found in its existing posts, so none is invented.' };
    if (!caps.types.has('rawHtml')) return { ok: false, reason: 'renderer-cannot-draw', error: 'The site\'s renderer does not draw raw HTML blocks, which is how its tables are stored.' };
    blocks.push({ _key: newKey(), _type: 'rawHtml', html: tableHtml(section.table, tableMarkup) });
  }
  return { ok: true, blocks };
}

/**
 * Pure. Q&A items ({question, answer}) to blocks: each question is a question heading (h3) and its answer a paragraph, woven into the body. This is NOT a FAQ box:
 * it has no section heading of its own and is the platform's separate "Q&A" slot (generators/qa-content.js). A question the post already has as a heading is skipped.
 */
export function qaToBlocks(items, { capabilities, existing = new Set(), newKey = newAiKey } = {}) {
  const caps = capabilities;
  if (!caps.blockStyles.has('h3') || !caps.blockStyles.has('normal')) return { ok: false, reason: 'renderer-cannot-draw', error: 'The site\'s renderer does not draw h3 headings and paragraphs.' };
  const blocks = []; const skipped = [];
  for (const it of Array.isArray(items) ? items : []) {
    const q = String(it?.question ?? '').trim(); const a = String(it?.answer ?? '').trim();
    if (!q || !a) return { ok: false, reason: 'draft-not-ready', error: 'A Q&A item has no question or no answer.' };
    if (existing.has(normalizeHeading(q))) { skipped.push(q); continue; }
    blocks.push(textBlock(q, { style: 'h3', newKey }), textBlock(a, { newKey }));
    existing.add(normalizeHeading(q));
  }
  if (blocks.some((b) => b.markDefs?.length) && !caps.marks.has('link')) return { ok: false, reason: 'renderer-cannot-draw', error: 'The site\'s renderer does not draw links.' };
  return { ok: true, blocks, skipped };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Where the new sections go

const CLOSING_HEADING = /^(related|read more|further reading|sources?|references?|faqs?|frequently asked|conclusion|final thoughts|summary|next steps|key takeaways|need help|get in touch|contact)/i;
const CTA_CLASS = /class="[^"]*\b(cta-banner|inline-cta)\b/;
// A call to action is a small, standalone block. A whole article stored as one raw-HTML block can CONTAIN a cta-banner; it is not one (found on real Admizz
// posts: treating it as the CTA put the new section above the entire article).
export const isCtaBlock = (b) => b?._type === 'rawHtml' && CTA_CLASS.test(b.html || '') && String(b.html).length < 2000 && !/<h[1-6]\b/i.test(b.html);
export const blockText = (b) => (b?.children || []).map((c) => c.text || '').join('');
export const normalizeHeading = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Pure. Index where trailing call-to-action blocks start (content.length when there are none). A CTA is the site's own cta-banner / inline-cta block. */
export function ctaStart(content) {
  let i = content.length;
  while (i > 0 && isCtaBlock(content[i - 1])) i--;
  return i;
}

/**
 * Pure. Where to insert, so the new text sits ABOVE the call to action and (for body sections) above the post's own closing part:
 *   'body'    before the closing part (a "Conclusion" / "Related reading" / "FAQ" heading in the last half of the post), else before the CTA
 *   'sources' after the closing part, directly before the CTA: references belong at the end, still above it
 */
export function insertionIndex(content, kind = 'body') {
  const cta = ctaStart(content);
  if (kind === 'sources') return cta;
  const half = Math.floor(content.length / 2);
  for (let i = half; i < cta; i++) {
    const b = content[i];
    if (b?._type === 'block' && /^h[23]$/.test(b.style || '') && CLOSING_HEADING.test(blockText(b).trim())) return i;
  }
  return cta;
}

/**
 * Pure. True when most of the post's body is raw HTML (a whole page pasted in, styled by its own CSS). Plain blocks added to it would not match its design, and
 * there is no safe place inside the HTML, so such a post is not edited by this adapter.
 */
export function rawHtmlDominates(content) {
  let raw = 0; let text = 0;
  for (const b of content) {
    if (b?._type === 'rawHtml') raw += String(b.html || '').replace(/<[^>]*>/g, '').length;
    else if (b?._type === 'block') text += blockText(b).length;
  }
  return raw > text;
}

/** Pure. Headings already present, so a section the post already has is never added twice. */
export function existingHeadings(content) {
  return new Set(content.filter((b) => b?._type === 'block' && /^h[2-4]$/.test(b.style || '')).map((b) => normalizeHeading(blockText(b))));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Writing and proving the edit

export const canonicalJson = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
/** True when the file is exactly what canonicalJson would write, so an edit changes nothing but the inserted blocks. */
export const isCanonicalJson = (text) => { try { return canonicalJson(JSON.parse(text)) === text; } catch { return false; } };

/**
 * The safety proof, from the TEXT of both files (nothing is trusted from the code that built the edit): the top-level fields other than the body are identical, the
 * body before and after the insertion point is identical block for block, and what sits between is exactly the inserted blocks.
 */
export function verifyBodyEdit(beforeText, afterText, { field = 'content', index, inserted }) {
  let b; let a;
  try { b = JSON.parse(beforeText); a = JSON.parse(afterText); } catch { return { ok: false, error: 'a file does not parse as JSON' }; }
  if (!Array.isArray(b[field]) || !Array.isArray(a[field])) return { ok: false, error: `${field} is not an array` };
  if (JSON.stringify(Object.keys(b)) !== JSON.stringify(Object.keys(a))) return { ok: false, error: 'the set or order of top-level fields changed' };
  for (const k of Object.keys(b)) if (k !== field && JSON.stringify(b[k]) !== JSON.stringify(a[k])) return { ok: false, error: `field "${k}" changed` };
  if (a[field].length !== b[field].length + inserted.length) return { ok: false, error: 'the number of blocks is not old + inserted' };
  const head = JSON.stringify(a[field].slice(0, index)) === JSON.stringify(b[field].slice(0, index));
  const mid = JSON.stringify(a[field].slice(index, index + inserted.length)) === JSON.stringify(inserted);
  const tail = JSON.stringify(a[field].slice(index + inserted.length)) === JSON.stringify(b[field].slice(index));
  if (!head) return { ok: false, error: 'blocks before the insertion point changed' };
  if (!mid) return { ok: false, error: 'the inserted blocks are not what was intended' };
  if (!tail) return { ok: false, error: 'blocks after the insertion point changed' };
  return { ok: true };
}
