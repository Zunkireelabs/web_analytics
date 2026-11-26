// LEARNS A SITE'S OWN FAQ BLOCK FROM ITS POSTS, in whatever HTML shape they use.
//
// A site can have more than one FAQ form: Zunkiree writes the FAQ of a blog post as a left-aligned grey card at the end of the post, and the FAQ of a page as a
// different, centred section. The site-wide captured template comes from one page, so a blog post written with it was held ("the block's text is center-aligned but
// this page's own paragraphs are left-aligned", 2026-11-26). The FAQ of a post is whatever the site's OTHER posts have, so it is read from them.
//
// Pure: takes the raw text of sibling posts, returns { wrapper, row } (the same template shape marker-merge.js renders: `{{ROWS}}` in the wrapper, `{{QUESTION}}` and
// `{{ANSWER}}` in the row) or null. Nothing is invented: a template is returned only when it reproduces the siblings' own block EXACTLY from their own questions and
// answers, and at least two posts agree on it.

const TOKEN = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g;
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr']);
const FAQ_HEADING = /^\s*(frequently asked questions|faqs?|common questions|questions and answers|questions? & answers?)\s*:?\s*$/i;

function parse(html) {
  const root = { tag: '#root', open: '', children: [] };
  const stack = [root];
  for (const m of String(html).matchAll(TOKEN)) {
    const t = m[0];
    const top = stack[stack.length - 1];
    if (t.startsWith('<!--')) { top.children.push({ comment: t }); continue; }
    if (t[0] !== '<') { top.children.push({ text: t }); continue; }
    if (t[1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const tag = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(t)[1].toLowerCase();
    const node = { tag, open: t, children: [], selfClosed: VOID.has(tag) || /\/>$/.test(t) };
    top.children.push(node);
    if (!node.selfClosed) stack.push(node);
  }
  return root;
}

const isText = (n) => n.text !== undefined;
const textOf = (n) => (isText(n) ? n.text : n.comment ? '' : n.children.map(textOf).join(''));
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const elementKids = (n) => n.children.filter((c) => !isText(c) && !c.comment);
const hasOwnText = (n) => n.children.some((c) => isText(c) && clean(c.text));

// What a node looks like, ignoring its words: tag, opening tag text and the shape of its children.
function shape(n) {
  if (isText(n)) return 't';
  if (n.comment) return '';
  if (n.virtual) return `[${n.children.map(shape).join(',')}]`;
  return `${n.open}(${n.children.map(shape).join(',')})`;
}

function render(n, slot) {
  if (isText(n)) return n.text;
  if (n.comment) return n.comment;
  if (n.virtual) return n.children.map((c) => render(c, slot)).join('');
  const inner = n.children.map((c) => render(c, slot)).join('');
  return n.selfClosed ? n.open : `${n.open}${inner}</${n.tag}>`;
}

// The text-bearing leaf elements of a row, in order (question first, answer second).
function leaves(n, out = []) {
  if (isText(n) || n.comment) return out;
  if (hasOwnText(n) && !elementKids(n).length) out.push(n);
  else for (const c of n.children) leaves(c, out);
  return out;
}

function rowTemplate(row) {
  const ls = leaves(row);
  if (ls.length !== 2) return null;
  const tmp = new Map([[ls[0], '{{QUESTION}}'], [ls[1], '{{ANSWER}}']]);
  const ser = (n) => {
    if (isText(n)) return n.text;
    if (n.comment) return n.comment;
    if (n.virtual) return n.children.map(ser).join('');
    if (tmp.has(n)) return `${n.open}${tmp.get(n)}</${n.tag}>`;
    return n.selfClosed ? n.open : `${n.open}${n.children.map(ser).join('')}</${n.tag}>`;
  };
  return { template: ser(row), question: clean(textOf(ls[0])), answer: clean(textOf(ls[1])) };
}

// Find the node whose element children include a run of at least two rows with the same shape and exactly two text leaves each.
function findRows(root) {
  let best = null;
  const walk = (n) => {
    if (isText(n) || n.comment) return;
    let kids = elementKids(n);
    // A definition list is written as dt, dd, dt, dd...: each pair is one row.
    if (n.tag === 'dl' && kids.length >= 4 && kids.length % 2 === 0 && kids.every((k, i) => k.tag === (i % 2 ? 'dd' : 'dt'))) {
      const pairs = [];
      for (let i = 0; i < kids.length; i += 2) pairs.push({ virtual: true, tag: '#pair', open: '', children: [kids[i], kids[i + 1]], first: kids[i], last: kids[i + 1] });
      kids = pairs;
    }
    if (kids.length >= 2) {
      // The longest run of neighbours with the same shape (a heading may sit beside them), each a question and an answer.
      const shapes = kids.map(shape);
      let i = 0;
      while (i < kids.length) {
        let j = i;
        while (j + 1 < kids.length && shapes[j + 1] === shapes[i]) j++;
        if (j > i && rowTemplate(kids[i]) && (!best || j - i + 1 > best.rows.length)) best = { parent: n, rows: kids.slice(i, j + 1) };
        i = j + 1;
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return best;
}

/** One post: the FAQ block it carries (between SEOAI:FAQ markers, or the container of a "Frequently asked questions" heading), as { wrapper, row, items } or null. */
export function faqBlockTemplate(raw) {
  const text = String(raw || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  let block = null;
  const marked = /<!--\s*SEOAI:FAQ:START\s*-->([\s\S]*?)<!--\s*SEOAI:FAQ:END\s*-->/.exec(text);
  if (marked) block = marked[1];
  if (!block) {
    // Unmarked: a heading that says "Frequently asked questions", and the element that holds it together with the questions.
    const h = /<(h[1-6])\b[^>]*>\s*([^<]*)<\/\1>/gi;
    for (let m = h.exec(text); m; m = h.exec(text)) {
      if (!FAQ_HEADING.test(m[2])) continue;
      // The container is the nearest <div>/<section>/<aside> that opens before the heading and is still open after it; take it through its balanced end.
      const headingEnd = m.index + m[0].length;
      let pick = null;
      for (const tag of ['div', 'section', 'aside']) {
        const openIdx = text.slice(0, m.index).lastIndexOf(`<${tag}`);
        if (openIdx < 0) continue;
        let depth = 0; let end = -1;
        for (const t of text.slice(openIdx).matchAll(new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi'))) {
          depth += t[0][1] === '/' ? -1 : 1;
          if (depth === 0) { end = openIdx + t.index + t[0].length; break; }
        }
        if (end > headingEnd && (!pick || openIdx > pick.openIdx)) pick = { openIdx, end };
      }
      if (pick) { block = text.slice(pick.openIdx, pick.end); break; }
    }
  }
  // The structured-data script that travels with a FAQ is different in every post and is produced separately: the block's design is everything else.
  if (block) block = block.replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, '');
  if (!block || !block.trim()) return null;

  const root = parse(block.trim());
  const found = findRows(root);
  if (!found) return null;
  const rowNodes = found.rows;
  const first = rowTemplate(rowNodes[0]);
  if (!first) return null;
  // The wrapper is the block with the whole run of rows replaced by one {{ROWS}}.
  const marker = { text: '{{ROWS}}' };
  const parent = found.parent;
  const spanStart = (r) => (r.virtual ? r.first : r);
  const spanEnd = (r) => (r.virtual ? r.last : r);
  const firstIdx = parent.children.indexOf(spanStart(rowNodes[0]));
  const lastIdx = parent.children.indexOf(spanEnd(rowNodes[rowNodes.length - 1]));
  const kept = parent.children.slice();
  kept.splice(firstIdx, lastIdx - firstIdx + 1, marker);
  const originalChildren = parent.children;
  parent.children = kept;
  const wrapper = root.children.map((c) => render(c)).join('');
  parent.children = originalChildren;
  if (!wrapper.includes('{{ROWS}}')) return null;

  // PROOF: the template, filled with this post's own questions and answers, must reproduce the post's own block exactly (whitespace aside).
  const items = rowNodes.map((r) => rowTemplate(r)).map((r) => (r ? { q: r.question, a: r.answer } : null));
  if (items.some((i) => !i)) return null;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rebuilt = wrapper.replace('{{ROWS}}', items.map((i) => first.template.replace('{{QUESTION}}', esc(i.q)).replace('{{ANSWER}}', esc(i.a))).join(''));
  const norm = (s) => s.replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, '').replace(/>\s+</g, '><');
  if (norm(rebuilt) !== norm(block)) return null;
  return { wrapper, row: first.template, items: items.length };
}

/** The site's FAQ template for this collection: the form most of the posts that carry a FAQ share (at least two posts, more than half of them). */
export function learnHtmlFaqTemplate(siblings) {
  const found = (siblings || []).map(faqBlockTemplate).filter(Boolean);
  if (found.length < 2) return null;
  const counts = new Map();
  for (const f of found) { const k = `${f.wrapper}\u0000${f.row}`; counts.set(k, { n: (counts.get(k)?.n || 0) + 1, f }); }
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  if (!best || best.n < 2 || best.n <= found.length / 2) return null;
  return { wrapper: best.f.wrapper, row: best.f.row, learnedFrom: best.n };
}
