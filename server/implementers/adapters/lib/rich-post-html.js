import * as cheerio from 'cheerio';
import { tableHtml } from './portable-text-body.js';

// PURE helpers for adding a section to a post that is ONE raw-HTML block built from the site's "rich post" template (admizz-web-dev: 10 of 40 sampled posts), e.g.
//   <div> <div class="quick-facts">..</div> <section class="section" id="s1"><h2>..</h2><p>..</p></section> ... <div class="cta-banner">..</div>
//         <section class="section" id="faq"><div class="faq-item">..</div></section> </div>
// styled by the post's own <style> and the site's shared stylesheet.
//
// THE RULE THAT KEEPS THE DESIGN: the new section is written in the page's OWN markup, and only with tags the page already uses. A list is written only if the post
// already contains lists, an h3 only if it already contains h3 headings, a table only in the table markup the post already has. Anything else is REFUSED, never
// approximated. The new section is inserted at the top level between existing sections, directly above the call to action (or the FAQ section), and the edit is
// proven to be a pure insertion at exactly that offset.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const normHeading = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const norm = normHeading;
const offsetOf = (el) => el?.sourceCodeLocation?.startOffset ?? -1;
const load = (html) => cheerio.load(html, { sourceCodeLocationInfo: true }, false);

/**
 * Pure. Reads the page's structure.
 * @returns {{ ok:true, insertAt:number, nextId:string, uses:{h3:boolean, ul:boolean, ol:boolean}, tableMarkup:{wrapperClass:string, tableClass:string}|null, headings:Set<string> }
 *          | { ok:false, error:string }}
 */
export function analyzeRichPost(html) {
  const $ = load(html);
  // Content sections: every top-level <section class="section" id="..."> except the FAQ and sources/related ones, which sit at the end.
  const NOT_CONTENT = /^(faq|faqs|sources?|references?|related)/i;
  const sections = $('section.section[id]').toArray().filter((el) => !NOT_CONTENT.test(el.attribs.id));
  if (!sections.length) return { ok: false, error: 'the page has no content sections (section.section with an id) to place a new one beside' };
  const container = sections[0].parent;
  if (!container || sections.some((s) => s.parent !== container)) return { ok: false, error: 'the content sections are not all at the same level, so there is no safe place between them' };

  const lastSection = Math.max(...sections.map(offsetOf));
  const anchors = $(container).children('.cta-banner, .inline-cta, section#faq').toArray().filter((el) => offsetOf(el) > lastSection);
  if (!anchors.length) return { ok: false, error: 'there is no call-to-action or FAQ section after the content sections to place the new one above' };
  const insertAt = Math.min(...anchors.map(offsetOf));

  const ids = new Set($('[id]').toArray().map((el) => el.attribs.id));
  const numeric = sections.every((s) => /^s\d+$/.test(s.attribs.id));
  const nextNumber = numeric ? Math.max(...sections.map((s) => Number(s.attribs.id.slice(1)))) + 1 : null;
  const table = $('table[class]').first();
  const wrap = table.length ? table.parent() : null;
  const tableMarkup = table.length && wrap?.is('div[class]') ? { wrapperClass: wrap.attr('class'), tableClass: table.attr('class') } : null;
  const headings = new Set($('h2, h3').toArray().map((h) => norm($(h).text())));
  const styleText = $('style').toArray().map((el) => $(el).text()).join('\n');
  const styleEnd = $('style').first().get(0)?.sourceCodeLocation?.endTag?.startOffset ?? -1; // where more rules may be added to the page's own <style>
  return { ok: true, insertAt, styleText, styleEnd, idStyle: numeric ? 'numeric' : 'named', nextNumber, ids, uses: { h3: $('h3').length > 0, ul: $('ul').length > 0, ol: $('ol').length > 0 }, tableMarkup, headings };
}

/**
 * Pure. An id for a new section that follows the page's own habit: numbered pages continue the numbering (s5, s6), named pages get an id from the heading
 * (intro, what-is-x). `taken` (a Set, updated here) keeps every id on the page unique.
 */
export function nextSectionId(analysis, heading, taken = analysis.ids) {
  if (analysis.idStyle === 'numeric') {
    let n = analysis.nextNumber; while (taken.has(`s${n}`)) n++;
    analysis.nextNumber = n + 1; taken.add(`s${n}`);
    return `s${n}`;
  }
  const base = String(heading || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'section';
  let id = base; let i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  taken.add(id);
  return id;
}

const INLINE = /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
/** Pure. Markdown-ish inline text to escaped HTML: links (external ones open in a new tab, as in the site's posts), bold, italic. */
export function inlineToHtml(text) {
  let out = ''; let last = 0;
  const t = String(text ?? '');
  for (const m of t.matchAll(INLINE)) {
    out += esc(t.slice(last, m.index));
    if (m[1]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(m[1]);
      out += `<a href="${esc(href)}"${/^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(label)}</a>`;
    } else if (m[2]) out += `<strong>${esc(m[2].slice(2, -2))}</strong>`;
    else out += `<em>${esc(m[3].slice(1, -1))}</em>`;
    last = m.index + m[0].length;
  }
  return out + esc(t.slice(last));
}

/** Pure. A body text (paragraphs, "- " bullets, "1. " numbers) to HTML, or a refusal when the page does not already use a list. */
function bodyToHtml(body, uses) {
  const out = []; let para = []; let list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inlineToHtml(para.join(' ').trim())}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineToHtml(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line); const number = /^\d+[.)]\s+(.*)$/.exec(line);
    if (!line) { flushPara(); flushList(); continue; }
    if (bullet || number) {
      const tag = bullet ? 'ul' : 'ol';
      if (!uses[tag]) return { ok: false, reason: 'page-style-unknown', error: `The page uses no <${tag}> lists, so how one would look is unknown and none is written.` };
      flushPara();
      if (list && list.tag !== tag) flushList();
      (list ||= { tag, items: [] }).items.push((bullet || number)[1]);
    } else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return { ok: true, html: out.join('') };
}

/** Pure. One generated section ({heading, body, table?}) as the page's own <section class="section" id="sN">. */
export function richSectionHtml(section, { id, uses, tableMarkup }) {
  const heading = String(section?.heading ?? '').trim();
  if (!heading) return { ok: false, reason: 'draft-not-ready', error: 'A section has no heading.' };
  const body = bodyToHtml(section.body, uses);
  if (!body.ok) return body;
  let table = '';
  if (Array.isArray(section.table) && section.table.length) {
    if (!tableMarkup) return { ok: false, reason: 'no-table-design', error: 'This draft has a table, but the page has no table of its own to copy the design from, so none is invented.' };
    table = tableHtml(section.table, tableMarkup);
  }
  return { ok: true, html: `<section class="section" id="${id}"><h2>${esc(heading)}</h2>${body.html}${table}</section>` };
}

/**
 * Pure. Q&A items as the page's own sections, in a heading style the page already has:
 *   the page uses h3 headings  one section with each question as an h3 and its answer as a paragraph;
 *   the page uses only h2      each question is its own small section (<section class="section"><h2>Question?</h2><p>Answer</p></section>), because h2 is the
 *                              heading look the page already has, and an unstyled h3 would not match it.
 * `idFor(label)` gives each new section a unique id in the page's own habit.
 */
export function richQaHtml(items, { idFor, uses, existing = new Set() }) {
  const rows = []; const skipped = [];
  for (const it of Array.isArray(items) ? items : []) {
    const q = String(it?.question ?? '').trim(); const a = String(it?.answer ?? '').trim();
    if (!q || !a) return { ok: false, reason: 'draft-not-ready', error: 'A Q&A item has no question or no answer.' };
    if (existing.has(norm(q))) { skipped.push(q); continue; }
    rows.push({ q, a });
    existing.add(norm(q));
  }
  if (!rows.length) return { ok: true, html: '', skipped };
  if (uses.h3) {
    return { ok: true, skipped, html: `<section class="section" id="${idFor('questions')}">${rows.map((r) => `<h3>${esc(r.q)}</h3><p>${inlineToHtml(r.a)}</p>`).join('')}</section>` };
  }
  return { ok: true, skipped, html: rows.map((r) => `<section class="section" id="${idFor(r.q)}"><h2>${esc(r.q)}</h2><p>${inlineToHtml(r.a)}</p></section>`).join('') };
}

/**
 * Pure. The proof: the new HTML is the old HTML with exactly the given insertions ({at, text}, offsets into the old text) and nothing else, and the sections the
 * insertions add sit at the same level as the existing ones. A single insertion may also be given as {at, fragment}.
 */
export function verifyRichEdit(beforeHtml, afterHtml, { at, fragment, insertions } = {}) {
  const ins = insertions || [{ at, text: fragment }];
  if (applyInsertions(beforeHtml, ins) !== afterHtml) return { ok: false, error: 'the page changed somewhere other than the inserted text' };
  const numbered = ($$) => $$('section.section[id]').toArray().filter((el) => !/^(faq|faqs|sources?|references?|related)/i.test(el.attribs.id));
  const was = numbered(load(beforeHtml)); const now = numbered(load(afterHtml));
  const parent = now[0]?.parent;
  if (now.length <= was.length || now.some((s) => s.parent !== parent)) return { ok: false, error: 'the new section is not at the same level as the existing ones' };
  return { ok: true };
}

/**
 * Pure. The table markup this page may use: its own table's, or the site's (from the adapter config / other posts) when this page's own CSS already defines
 * both classes, or when it carries no CSS of its own (the site's shared stylesheet then applies). Otherwise none: how a table would look here is unknown.
 */
export function resolveTableMarkup(analysis, siteMarkup) {
  if (analysis.tableMarkup) return analysis.tableMarkup;
  if (!siteMarkup?.tableClass || !siteMarkup?.wrapperClass) return null;
  const css = analysis.styleText || '';
  if (!css.trim()) return siteMarkup;
  return css.includes(`.${siteMarkup.tableClass}`) && css.includes(`.${siteMarkup.wrapperClass}`) ? siteMarkup : null;
}

/**
 * Pure. The proof for a post whose body is ONE raw-HTML block, from the TEXT of both files: every top-level field except the body is identical, every block other than
 * the page's is identical, the page block differs only in its `html`, and that html is the old one with exactly `fragment` inserted at `at`.
 */
export function verifyRichBlockEdit(beforeText, afterText, { field = 'content', blockIndex, at, fragment, insertions }) {
  let b; let a;
  try { b = JSON.parse(beforeText); a = JSON.parse(afterText); } catch { return { ok: false, error: 'a file does not parse as JSON' }; }
  if (JSON.stringify(Object.keys(b)) !== JSON.stringify(Object.keys(a))) return { ok: false, error: 'the set or order of top-level fields changed' };
  for (const k of Object.keys(b)) if (k !== field && JSON.stringify(b[k]) !== JSON.stringify(a[k])) return { ok: false, error: `field "${k}" changed` };
  if (!Array.isArray(b[field]) || !Array.isArray(a[field]) || b[field].length !== a[field].length) return { ok: false, error: 'the number of blocks changed' };
  for (let i = 0; i < b[field].length; i++) if (i !== blockIndex && JSON.stringify(b[field][i]) !== JSON.stringify(a[field][i])) return { ok: false, error: `block ${i} changed` };
  const bb = b[field][blockIndex]; const ab = a[field][blockIndex];
  if (!bb || !ab || JSON.stringify({ ...bb, html: 0 }) !== JSON.stringify({ ...ab, html: 0 })) return { ok: false, error: 'the page block changed in more than its html' };
  return verifyRichEdit(bb.html, ab.html, { at, fragment, insertions });
}

/**
 * Pure. The site's own rules for its table, read from its stylesheet source (admizz-web-dev: RICH_POST_CSS in src/components/lib/blog-rich-styles.ts): every rule
 * in the shared post stylesheet whose selector names the wrapper or the table class. Rules for the renderer's scoped overrides (.blog-raw-content ...) are not taken.
 * Null when the stylesheet defines none, so nothing is invented.
 */
export function extractTableCss(source, markup) {
  const text = String(source ?? '');
  const start = text.indexOf('RICH_POST_CSS');
  if (start < 0 || !markup?.tableClass || !markup?.wrapperClass) return null;
  const open = text.indexOf('`', start); const close = open < 0 ? -1 : text.indexOf('`', open + 1);
  if (close < 0) return null;
  const css = text.slice(open + 1, close);
  const wanted = [`.${markup.tableClass}`, `.${markup.wrapperClass}`];
  const rules = [...css.matchAll(/(?:^|\n)[ \t]*([^{}\n]+)\{([^{}]*)\}/g)]
    .filter((m) => !/blog-raw-content/.test(m[1]) && wanted.some((w) => m[1].includes(w)))
    .map((m) => `${m[1].trim()}{${m[2]}}`);
  return rules.length ? rules.join('\n') : null;
}

/** Pure. Applies insertions ({at, text}, offsets into the ORIGINAL string) in one pass. */
export function applyInsertions(text, insertions) {
  const sorted = [...insertions].sort((a, b) => a.at - b.at);
  let out = ''; let prev = 0;
  for (const ins of sorted) { out += text.slice(prev, ins.at) + ins.text; prev = ins.at; }
  return out + text.slice(prev);
}

/** Pure. Headings already on the page, as normalised text. */
export const richHeadings = (html) => analyzeRichPost(html).headings ?? new Set();
