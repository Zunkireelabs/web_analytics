// HTML-BODY BLOG POSTS (Eleventy/Nunjucks `.njk` targets), written in the client's OWN format.
//
// A `.njk` template is not Markdown: its body is output as written, so a `## heading` would reach the browser as literal text. The posts such a site
// already publishes are plain semantic HTML (<p>, <h2>, <h3>, <ul>/<ol>/<li>, <strong>, <a>) with no classes and no wrapper, placed inside the layout's own
// article container, which styles them. Everything around the body (title, hero, cover, FAQ, related reading, CTAs) is built by the layout from FRONT MATTER.
// This module writes exactly that: the front matter keys the site's real posts declare, and an HTML-only body.
//
// Nothing here invents customer-facing content and nothing is copied from another client: every value is the draft's own text, or is taken from a real post
// of THIS site (same category), or the draft is refused with what a person must supply. Opt-in by target shape: extension .njk/.html, not `clone-sibling`,
// not a `filename` (TSX) target. Every other client's blog target is unchanged.
import { marked } from 'marked';
import { getRepoTree, getFileContent, defaultBranchName } from '../../github/client.js';

export const isHtmlBodyTarget = (cfg) => Boolean(cfg) && ['.njk', '.html'].includes(String(cfg.extension || '').toLowerCase()) && cfg.mode !== 'clone-sibling' && !cfg.filename;

const notReady = (error) => ({ ok: false, reason: 'draft-not-ready', error });

// ───────────────────────────── front matter: a strict reader for the subset real posts use ─────────────────────────────
// Top-level `key: scalar`, quoted or bare, with an optional trailing `# comment`; lists of scalars; lists of maps (`  - k: v` then `    k: v`). Anything else
// returns null: a post this reader cannot read exactly is never used as a model.
function readScalar(s) {
  const t = s.trim();
  if (t.startsWith('"')) {
    let i = 1; while (i < t.length && !(t[i] === '"' && t[i - 1] !== '\\')) i++;
    if (i >= t.length) throw new Error('unterminated string');
    const rest = t.slice(i + 1).trim();
    if (rest && !rest.startsWith('#')) throw new Error('text after a quoted string');
    return { value: JSON.parse(t.slice(0, i + 1)), comment: rest.startsWith('#') ? rest.slice(1).trim() : null };
  }
  if (t.startsWith("'")) {
    let i = 1; while (i < t.length) { if (t[i] === "'" && t[i + 1] === "'") i += 2; else if (t[i] === "'") break; else i++; }
    if (i >= t.length) throw new Error('unterminated string');
    const rest = t.slice(i + 1).trim();
    return { value: t.slice(1, i).replaceAll("''", "'"), comment: rest.startsWith('#') ? rest.slice(1).trim() : null };
  }
  const m = t.match(/^(.*?)(?:\s+#\s*(.*))?$/);
  const raw = m[1].trim();
  if (/^-?\d+$/.test(raw)) return { value: Number(raw), comment: m[2] || null };
  if (raw === 'true' || raw === 'false') return { value: raw === 'true', comment: m[2] || null };
  return { value: raw, comment: m[2] || null };
}

export function parseFrontMatter(raw) {
  const m = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/); const data = {}; const markers = {}; const order = [];
  try {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const k = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
      if (!k) return null;
      const [, key, rest] = k; order.push(key);
      if (rest !== undefined && rest.trim() !== '') { const r = readScalar(rest); data[key] = r.value; if (r.comment) markers[key] = r.comment; continue; }
      // a list follows
      const list = []; let cur = null;
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        const l = lines[++i];
        const item = /^  - (.*)$/.exec(l);
        if (item) {
          const inner = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(item[1]);
          if (inner && !item[1].startsWith('"')) { cur = {}; list.push(cur); cur[inner[1]] = readScalar(inner[2] ?? '').value; } else { cur = null; list.push(readScalar(item[1]).value); }
          continue;
        }
        const cont = /^    ([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(l);
        if (cont && cur) { cur[cont[1]] = readScalar(cont[2] ?? '').value; continue; }
        return null;
      }
      data[key] = list;
    }
  } catch { return null; }
  return { data, markers, order };
}

const BARE_OK = /^[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*$/;
const q = (s) => JSON.stringify(String(s)); // a JSON string is a valid YAML double-quoted scalar
function emitScalar(v, bare) { return typeof v === 'number' || typeof v === 'boolean' ? String(v) : (bare && BARE_OK.test(String(v)) ? String(v) : q(v)); }

export function emitFrontMatter(data, { order, markers = {}, bareKeys = new Set() } = {}) {
  const keys = [...new Set([...(order || []), ...Object.keys(data)])].filter((k) => data[k] !== undefined);
  const out = ['---'];
  for (const key of keys) {
    const v = data[key];
    if (Array.isArray(v)) {
      out.push(`${key}:`);
      for (const item of v) {
        if (item && typeof item === 'object') {
          const ents = Object.entries(item); ents.forEach(([k2, v2], idx) => out.push(`${idx === 0 ? '  - ' : '    '}${k2}: ${emitScalar(v2, false)}`));
        } else out.push(`  - ${emitScalar(item, false)}`);
      }
    } else out.push(`${key}: ${emitScalar(v, bareKeys.has(key))}${markers[key] ? ` # ${markers[key]}` : ''}`);
  }
  out.push('---');
  return out.join('\n');
}

// ───────────────────────────── the HTML body ─────────────────────────────
// Escaped text. `{{`, `{%` and `{#` would be executed by Nunjucks, so the opening brace becomes an entity.
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\{(?=[{%#])/g, '&#123;');
const safeHref = (h) => (/^(https?:\/\/|\/|#|mailto:)/i.test(h) ? h : null);
const stripMd = (t) => String(t || '').replace(/\*\*|__/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

function inline(tokens, bad) {
  let out = '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text': out += t.tokens ? inline(t.tokens, bad) : esc(t.text); break;
      case 'escape': out += esc(t.text); break;
      case 'strong': out += `<strong>${inline(t.tokens, bad)}</strong>`; break;
      case 'em': out += `<em>${inline(t.tokens, bad)}</em>`; break;
      case 'link': { const h = safeHref(t.href); if (!h) { bad.add(`a link with an unsupported address (${t.href.slice(0, 40)})`); out += inline(t.tokens, bad); } else out += `<a href="${esc(h)}">${inline(t.tokens, bad)}</a>`; break; }
      case 'br': out += '<br>'; break;
      case 'html': out += esc(t.text); break;
      case 'codespan': bad.add('inline code'); out += esc(t.text); break;
      case 'image': bad.add('an image'); break;
      case 'del': out += inline(t.tokens, bad); break;
      default: out += esc(t.raw || t.text || '');
    }
  }
  return out;
}

function block(tokens, bad) {
  const out = [];
  for (const t of tokens || []) {
    if (t.type === 'space') continue;
    if (t.type === 'paragraph') out.push(`<p>${inline(t.tokens, bad)}</p>`);
    else if (t.type === 'heading') out.push(`<h3>${inline(t.tokens, bad)}</h3>`); // a heading inside a section body is a sub-subheading: never an H1/H2, never deeper than H3
    else if (t.type === 'list') {
      const tag = t.ordered ? 'ol' : 'ul';
      const items = t.items.map((it) => {
        const parts = []; let text = '';
        for (const c of it.tokens || []) { if (c.type === 'text') text += (text ? ' ' : '') + inline(c.tokens || [{ type: 'text', text: c.text }], bad); else if (c.type === 'list') parts.push(block([c], bad)); else if (c.type !== 'space') bad.add(`a ${c.type} inside a list item`); }
        return `<li>${text}${parts.join('')}</li>`;
      });
      out.push(`<${tag}>\n${items.join('\n')}\n</${tag}>`);
    } else if (t.type === 'html') out.push(`<p>${esc(String(t.text || '').trim())}</p>`);
    else bad.add(t.type === 'table' ? 'a table' : t.type === 'code' ? 'a code block' : t.type === 'blockquote' ? 'a quotation block' : t.type === 'hr' ? 'a horizontal rule' : `a ${t.type}`);
  }
  return out.join('\n');
}

const TAG_OK = /^<\/?(p|h2|h3|ul|ol|li|strong|em|a|br)(\s+href="[^"]*")?\s*\/?>$/;
export function renderHtmlBody(content) {
  const bad = new Set(); const parts = [];
  if (content?.quickAnswer && stripMd(content.quickAnswer)) parts.push(`<p><strong>${esc(stripMd(content.quickAnswer))}</strong></p>`);
  for (const s of content?.sections || []) {
    if (!s?.heading) continue;
    parts.push(`<h2>${esc(stripMd(s.heading))}</h2>`);
    const html = block(marked.lexer(String(s.body || '')), bad); if (html) parts.push(html);
  }
  if (bad.size) return notReady(`This site's posts use only paragraphs, H2/H3 headings, lists, bold, italics and links. This draft contains ${[...bad].join(', ')}, which none of them use. Nothing was written; a person must rework the draft (or confirm the site can display it).`);
  const html = parts.join('\n');
  const tags = html.match(/<[^>]*>/g) || [];
  const stray = tags.find((t) => !TAG_OK.test(t));
  if (stray) return notReady(`The generated body contains markup the site's posts never use (${stray.slice(0, 40)}); refused rather than written.`);
  if (/\{[{%#]/.test(html)) return notReady('The generated body contains template syntax that the site\'s build would execute; refused.');
  const text = html.replace(/<[^>]+>/g, ' ');
  return { ok: true, html, words: (text.match(/\S+/g) || []).length };
}

// ───────────────────────────── the site's own posts ─────────────────────────────
const CACHE = new Map(); const TTL_MS = 5 * 60_000; const MAX_POSTS = 120;
export async function readSiblingPosts(site, cfg, deps = {}) {
  const tree = deps.getRepoTree || getRepoTree; const read = deps.getFileContent || getFileContent;
  const branch = deps.ref || defaultBranchName(site);
  const key = `${site?.id}|${branch}|${cfg.dir}|${cfg.extension}`;
  const hit = CACHE.get(key); const now = (deps.now || Date.now)();
  if (!deps.noCache && hit && now - hit.at < TTL_MS) return hit.posts;
  const { files } = await tree(site, branch);
  const prefix = cfg.dir.endsWith('/') ? cfg.dir : `${cfg.dir}/`;
  const paths = (files || []).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p.endsWith(cfg.extension) && !/^(index|_)/.test(p.slice(prefix.length))).slice(0, MAX_POSTS);
  const posts = [];
  for (const p of paths) {
    const f = await read(site, p, branch).catch(() => null);
    const raw = typeof f === 'string' ? f : f?.content;
    const fm = raw ? parseFrontMatter(raw) : null;
    if (fm) posts.push({ slug: p.slice(prefix.length).replace(new RegExp(`${cfg.extension.replace('.', '\\.')}$`), ''), ...fm });
  }
  if (!deps.noCache) CACHE.set(key, { at: now, posts });
  return posts;
}

// ───────────────────────────── the post ─────────────────────────────
const stem = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ies)$/, 'y').replace(/s$/, '');
const words = (t) => new Set(String(t || '').split(/[^A-Za-z0-9]+/).map(stem).filter((w) => w.length > 2));
const firstSentences = (t, max = 200) => { const s = stripMd(t); const m = s.match(/^(.{20,}?[.!?])(\s|$)/); const one = m ? m[1] : s; const two = s.slice(0, max); return one.length >= 40 || s.length <= max ? one : two; };
const mostRecent = (posts) => [...posts].sort((a, b) => String(b.data.datePublished || '').localeCompare(String(a.data.datePublished || '')))[0];
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * @returns {{ok:true, body:string, slug?:string} | {ok:false, reason:string, error:string}}
 */
export function renderNjkPost(content, site, { posts = [], contract = null, today = new Date() } = {}) {
  if (!posts.length) return notReady('No existing post of this site could be read, so there is no format to follow. Nothing was written.');
  const html = renderHtmlBody(content); if (!html.ok) return html;

  // The keys every real post declares, and the values they all share, come from the posts themselves.
  const keySets = posts.map((p) => new Set(Object.keys(p.data)));
  const required = [...keySets[0]].filter((k) => keySets.every((s) => s.has(k)));
  const shared = (k) => { const vals = new Set(posts.map((p) => JSON.stringify(p.data[k]))); return vals.size === 1 ? posts[0].data[k] : undefined; };
  const reference = posts.find((p) => required.every((k) => p.order?.includes(k))) || posts[0];
  const order = reference.order;

  // Category: the human's choice if given, else a UNIQUE match against the site's own categories; otherwise a person decides.
  const cats = new Map(); for (const p of posts) { const c = p.data.category; if (c) cats.set(c, [...(cats.get(c) || []), p]); }
  const wanted = typeof content?.category === 'string' ? content.category.trim() : null;
  let category = wanted ? [...cats.keys()].find((c) => c.toLowerCase() === wanted.toLowerCase()) : null;
  if (wanted && !category) return notReady(`"${wanted}" is not one of this site's existing blog categories (${[...cats.keys()].join(', ')}). A person must choose one; a new category is never created.`);
  if (!category) {
    const text = words(`${content?.title || ''} ${content?.topic || ''}`);
    const scored = [...cats.keys()].map((c) => ({ c, n: [...words(c)].filter((w) => text.has(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    if (!scored.length || (scored[1] && scored[1].n === scored[0].n)) return notReady(`This draft does not point to exactly one of this site's blog categories (${[...cats.keys()].join(', ')}). A person must choose one; nothing was guessed.`);
    category = scored[0].c;
  }
  const exemplar = mostRecent(cats.get(category));

  const d = { ...Object.fromEntries(required.map((k) => [k, shared(k)]).filter(([, v]) => v !== undefined)) };
  const title = stripMd(content?.title || content?.topic || '');
  if (!title) return notReady('The draft has no title.');
  const brand = (() => { const sfx = posts.map((p) => /\|\s*([^|]+)$/.exec(String(p.data.title || ''))?.[1]?.trim()).filter(Boolean); const top = sfx.sort((a, b) => sfx.filter((x) => x === b).length - sfx.filter((x) => x === a).length)[0]; return top && sfx.length >= posts.length * 0.9 ? top : null; })();
  const h1 = brand ? title.replace(new RegExp(`\\s*\\|\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') : title;
  d.title = brand && !new RegExp(`\\|\\s*${brand}$`).test(title) ? `${title} | ${brand}` : title;
  d.h1 = h1;
  d.metaDescription = stripMd(content?.metaDescription || firstSentences(content?.quickAnswer || '', 155));
  if (!d.metaDescription) return notReady('The draft has no meta description or quick answer to take one from.');
  d.datePublished = isoDay(content?.publishedAt || today); d.dateModified = d.datePublished;
  d.category = category; d.categoryAnchor = exemplar.data.categoryAnchor;
  d.readTime = `${Math.max(1, Math.round(html.words / 200))} min read`;
  d.subtitle = firstSentences(content?.quickAnswer || content?.metaDescription || '');
  d.cardExcerpt = d.metaDescription;
  // Cover: an existing image of this site only (the human's choice if given and known, else the same-category post's own).
  const covers = new Map(posts.map((p) => [p.data.coverImage, p.data.coverAlt]));
  if (content?.coverImage && !covers.has(content.coverImage)) return notReady(`"${content.coverImage}" is not an image this site's posts already use. A person must choose an existing one.`);
  d.coverImage = content?.coverImage || exemplar.data.coverImage; d.coverAlt = content?.coverImage ? (content.coverAlt || covers.get(content.coverImage)) : exemplar.data.coverAlt;
  // Calls to action, related reading and "keep reading": the same-category post's own (real wording and real links). Never invented.
  for (const k of ['sidebarCtaHeading', 'sidebarCtaBody', 'bottomCtaHeading', 'bottomCtaBody', 'relatedReading', 'keepReading']) if (required.includes(k)) d[k] = exemplar.data[k];
  d.faq = (Array.isArray(content?.faqItems) ? content.faqItems : []).filter((x) => x?.question && x?.answer).map((x) => ({ question: stripMd(x.question), answer: stripMd(x.answer) }));
  if (required.includes('faq') && !d.faq.length) return notReady('This site\'s posts all carry FAQ items and the draft has none. A person must supply them.');

  const unknown = required.filter((k) => d[k] === undefined);
  if (unknown.length) return notReady(`Every post of this site declares ${unknown.map((k) => `"${k}"`).join(', ')} and the platform has no source for ${unknown.length === 1 ? 'it' : 'them'}. A person must supply ${unknown.length === 1 ? 'it' : 'them'}; nothing was guessed.`);

  const bareKeys = new Set(Object.keys(d).filter((k) => typeof d[k] === 'string' && posts.every((p) => typeof p.data[k] === 'string') && shared(k) !== undefined));
  const markers = {}; for (const k of ['title', 'metaDescription']) { const withMarker = posts.filter((p) => p.markers?.[k]); if (withMarker.length >= posts.length / 2) markers[k] = withMarker[0].markers[k]; }
  const fm = emitFrontMatter(d, { order, markers, bareKeys });
  return { ok: true, body: `${fm}\n${html.html}\n`, category, exemplar: exemplar.slug };
}

// ───────────────────────────── the order file (e.g. blogOrder.json) ─────────────────────────────
// A site whose build fails when a post is missing from its index lists every post's slug in one JSON array. The new slug is added to that file in the SAME commit.
// Per-tenant config: newContentTargets['blog-outline'].orderFile = { path, position: 'top' | 'bottom' }  (default 'top'; the position is the owner's decision
// and is confirmed with them before it is switched on). Idempotent; never creates the file; refuses anything that is not a JSON array of strings.
export async function computeOrderFileUpdate(site, slug, fetchFile, beforeRef) {
  const cfg = site?.url_file_map?.newContentTargets?.['blog-outline'] || {};
  const of = cfg.orderFile; if (!of?.path) return null;
  const file = await fetchFile(site, of.path, beforeRef);
  if (!file) return { ok: false, reason: 'invalid-edit', error: `${of.path} is configured as this site's post index but does not exist on "${beforeRef}"; refusing to create it from scratch.` };
  let arr; try { arr = JSON.parse(file.content); } catch { return { ok: false, reason: 'invalid-edit', error: `${of.path} is not valid JSON; refusing to guess its shape.` }; }
  if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) return { ok: false, reason: 'invalid-edit', error: `${of.path} is not a JSON array of slugs; refusing to guess its shape.` };
  if (arr.includes(slug)) return { ok: true, filePath: of.path, newContent: file.content, unchanged: true };
  const text = file.content; const open = text.indexOf('['); const close = text.lastIndexOf(']');
  const m = /\n([ \t]*)"/.exec(text.slice(open)); const indent = m ? m[1] : ' ';
  const top = (of.position || 'top') !== 'bottom';
  let next;
  if (!arr.length) next = `${text.slice(0, open + 1)}\n${indent}${q(slug)}\n${text.slice(close)}`;
  else if (top) next = `${text.slice(0, open + 1)}\n${indent}${q(slug)},${text.slice(open + 1)}`;
  else { const lastQuote = text.lastIndexOf('"', close); next = `${text.slice(0, lastQuote + 1)},\n${indent}${q(slug)}${text.slice(lastQuote + 1)}`; }
  try { const check = JSON.parse(next); if (check.length !== arr.length + 1 || check[top ? 0 : check.length - 1] !== slug) throw new Error('shape'); } catch { return { ok: false, reason: 'invalid-edit', error: `Adding "${slug}" to ${of.path} would not produce a valid index; refused.` }; }
  return { ok: true, filePath: of.path, newContent: next };
}
