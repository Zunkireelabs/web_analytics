// The Astro recipe for paginating a blog listing.
//
// How: the listing page keeps its own file, markup, styles and design. It learns to show ONE SLICE of its posts, chosen by a prop
// (`pagerPage`, 1 when it is the real /blog route). A new route, src/pages/<listing>/page/[page].astro, renders that same page component for
// pages 2..N, so pages 2 and up look exactly like page 1 because they ARE page 1's template. Nothing is copied from the listing, so no design
// can drift, and nothing of another client's is introduced.
//
// What it touches in the listing (everything else byte-for-byte):
//   - the one `const LIST = ...;` the template maps over becomes `const LISTAll = ...;` and LIST becomes the page's slice
//   - a pager (the site's own button classes) right after the list's container
//   - per-page title and description, added as a spread AFTER the layout tag's own attributes (`{...pagerMeta}`), so the existing
//     `title={/* SEOAI:TITLE */ "..."}` literal, which the setup automation edits in place, is left exactly as it is
//   - the SEOAI content markers, if any, are wrapped so they render on page 1 only (a numbered page is a slice, not a page to write content onto)
//
// Pure: source text in, new text out. It REFUSES, with a specific reason, anything it cannot do safely (see each refuse() below).
import { posix } from 'node:path';
import { firstComponentTag } from '../../../implementers/lib/astro-tag.js';

export const DEFAULT_PAGE_SIZE = 12;
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/;
const refuse = (reason, error) => ({ ok: false, reason, error });

// Scans JS text skipping strings, template literals and comments; calls visit(i, ch) for every other character.
function scan(src, visit) {
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (visit(i, c) === false) return;
  }
}

// Every top-level `const NAME = <expr>;` statement of the frontmatter: { name, start, exprStart, end } (end is just past the `;`).
function constStatements(fm) {
  const out = [];
  const re = /(^|\n)[ \t]*const\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m;
  while ((m = re.exec(fm))) {
    const start = m.index + m[1].length;
    const exprStart = m.index + m[0].length;
    let depth = 0, end = -1;
    scan(fm.slice(exprStart), (i, c) => {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ';' && depth === 0) { end = exprStart + i + 1; return false; }
      return true;
    });
    if (end < 0) return null;                       // a statement without `;` (ASI): too ambiguous to rewrite
    out.push({ name: m[2], start, exprStart, end });
    re.lastIndex = end;
  }
  return out;
}

const BUILTINS = new Set(['await', 'async', 'new', 'typeof', 'void', 'return', 'function', 'true', 'false', 'null', 'undefined', 'this',
  'getCollection', 'Date', 'Number', 'String', 'Boolean', 'Math', 'Object', 'Array', 'JSON', 'Set', 'Map', 'Infinity', 'NaN', 'in', 'of', 'instanceof']);

// Identifiers an expression reads that are neither properties (`.x`), object keys, arrow parameters nor builtins.
function freeIdentifiers(expr) {
  let code = '';
  scan(expr, (i, c) => { code += c; return true; });             // strings/comments dropped (their characters never reach `code`)
  const params = new Set();
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) for (const p of m[1].split(',')) { const n = /[A-Za-z_$][\w$]*/.exec(p); if (n) params.add(n[0]); }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) params.add(m[1]);
  const names = new Set();
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?!\s*:(?!:))/g)) names.add(m[1]);
  return [...names].filter((n) => !BUILTINS.has(n) && !params.has(n));
}

// Index just past the `}` closing the `{` at src[i] (HTML/JSX template text: strings and template literals skipped).
function skipBraces(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { const q = c; j++; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

const literalOf = (src, attr) => {
  if (attr.kind === 'string') return attr.value;
  if (attr.kind === 'marked') { const m = /(["'])((?:(?!\1)[^\\]|\\.)*)\1/.exec(src.slice(attr.valueStart, attr.valueEnd)); return m ? m[2] : null; }
  return null;
};
const jsStr = (s) => JSON.stringify(String(s));

function pagerMarkup(btn, cur, hrefFn) {
  const b = btn ? ` class="${btn}"` : '';
  const c = cur ? ` class="${cur}"` : '';
  return [
    '{pagerTotal > 1 && (',
    '<nav class="blog-pager" aria-label="Blog pages" style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;justify-content:center;margin:2rem 0">',
    `  {pagerPage > 1 && <a${b} href={${hrefFn}(pagerPage - 1)} rel="prev">Newer posts</a>}`,
    `  {Array.from({ length: pagerTotal }, (_, i) => i + 1).map((n) => n === pagerPage ? <span${c} aria-current="page">{n}</span> : <a${b} href={${hrefFn}(n)}>{n}</a>)}`,
    `  {pagerPage < pagerTotal && <a${b} href={${hrefFn}(pagerPage + 1)} rel="next">Older posts</a>}`,
    '</nav>',
    ')}',
  ].join('\n');
}

/**
 * @param {{ source: string, sourcePath: string, basePath: string, pageSize?: number, buttonClass?: string|null, currentClass?: string|null,
 *           trailingSlash?: 'always'|'never'|'ignore', existingFiles?: string[] }} p
 * @returns {{ ok: true, after: string, extraFiles: {path:string, after:string}[], notes: string[] } | { ok: false, reason: string, error: string }}
 */
export function planAstroPagination({ source, sourcePath, basePath, pageSize = DEFAULT_PAGE_SIZE, buttonClass = null, currentClass = null, trailingSlash = 'ignore', existingFiles = [] }) {
  const text = String(source ?? '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fence = FENCE.exec(text);
  if (!fence) return refuse('no-frontmatter', 'The listing has no --- frontmatter fence, so there is no place to read its posts from.');
  const fmStart = fence[0].indexOf(fence[1]);
  const fm = fence[1];
  const bodyStart = fence[0].length;
  const body = text.slice(bodyStart);

  const route = /^src\/pages\/(.+?)(?:\/index)?\.astro$/.exec(sourcePath || '');
  if (!route || /[\[\]]/.test(route[1])) return refuse('not-a-static-page', `${sourcePath} is not a plain page under src/pages, so the page 2+ route cannot be placed next to it.`);
  const noSlash = (basePath || '').replace(/\/+$/, '');
  if (!noSlash || noSlash !== `/${route[1]}`) return refuse('route-mismatch', `${sourcePath} does not serve ${basePath}, so the page 2+ route cannot be placed with confidence.`);
  const routePath = `src/pages/${route[1]}/page/[page].astro`;
  if (existingFiles.includes(routePath)) return refuse('route-exists', `${routePath} already exists, so this listing may already be paginated.`);
  if (/\bpagerPage\b|\bpagerTotal\b|\bpagerMeta\b|\bpagerHref\b|\bpagerSize\b/.test(text)) return refuse('names-in-use', 'The listing already uses names this recipe needs (pagerPage, pagerTotal, pagerMeta, pagerHref, pagerSize).');

  const stmts = constStatements(fm);
  if (!stmts) return refuse('statement-without-semicolon', 'The listing frontmatter has a const statement without a closing ";", which this recipe does not rewrite.');
  const maps = [...body.matchAll(/\{\s*([A-Za-z_$][\w$]*)\.map\(/g)];
  if (!maps.length) return refuse('no-list-map', 'No `{list.map(...)}` over a frontmatter constant was found in the listing, so its posts come from somewhere this recipe cannot paginate (hand-written cards, a component, a data file).');
  const names = [...new Set(maps.map((m) => m[1]))];
  if (names.length > 1 || maps.length > 1) return refuse('several-lists', 'The listing maps over more than one list (or the same one in more than one place), so it is not clear which is the blog post list.');
  const listName = names[0];
  const decl = stmts.find((s) => s.name === listName);
  if (!decl) return refuse('list-not-a-const', `${listName} is not a plain const in the frontmatter, so it cannot be sliced.`);
  const astroInit = fm.slice(decl.exprStart, decl.end);
  if (/\.slice\(\s*[^,()]+,\s*[^)]+\)/.test(astroInit)) return refuse('list-is-truncated', `${listName} is cut to its first few posts inside the page (${astroInit.match(/\.slice\([^)]*\)/)[0]}), so it is a teaser rather than the full list of posts, and paginating it would not cover the rest.`);
  // Only real code counts: comments and strings are dropped from the frontmatter, and the template is read only inside its `{ ... }` expressions
  // (prose such as "the rest of the page" is not a reference).
  const code = (src) => { let out = ''; scan(src, (i, c) => { out += c; return true; }); return out; };
  const refs = (src) => [...src.matchAll(new RegExp(`(?<![.\\w$])${listName.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))].length;
  const refs2 = (src, name) => [...src.matchAll(new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))].length;
  const templateExprList = (src) => { const out = []; for (let i = 0; i < src.length; i++) { if (src[i] === '{') { const e = skipBraces(src, i); if (e < 0) break; out.push(code(src.slice(i, e))); i = e - 1; } } return out; };
  const templateExprs = (src) => templateExprList(src).join('\n');
  if (refs(code(fm.slice(0, decl.start))) + refs(code(fm.slice(decl.end))) > 0) return refuse('list-used-elsewhere', `${listName} is used elsewhere in the frontmatter, so replacing it with a slice would change other parts of the page.`);
  if (refs(templateExprs(body)) !== 1) return refuse('list-used-elsewhere', `${listName} is used more than once in the template, so replacing it with a slice would change other parts of the page.`);

  // The statements the list is computed from (the list itself, and the consts it reads, transitively): copied into the new route so it can
  // count the posts. Anything else it needs (an import, a helper) is a refusal: the new route could not reproduce the count.
  const byName = new Map(stmts.map((s) => [s.name, s]));
  const closure = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    const s = byName.get(name);
    if (!s) return name;
    for (const id of freeIdentifiers(fm.slice(s.exprStart, s.end - 1))) { const r = visit(id); if (r !== true) return r; }
    closure.push(s);
    return true;
  };
  const unresolved = visit(listName);
  if (unresolved !== true) return refuse('list-needs-helpers', `The list is computed using "${unresolved}", which is not a constant of the listing's frontmatter (an import or helper), so the new page 2+ route could not count the posts the same way.`);
  // Sections above or below the list that are driven by a constant the list is computed from (a "featured" post, say) belong to page 1: shown
  // again on every page they would put the same post on all of them. Such a constant is kept whole as NAMEAll and exposed as NAME only on
  // page 1, which is safe only when the template already treats it as optional (`{NAME && (...)}` or `{NAME ? ... : ...}`).
  const exprs = templateExprList(body);
  const extras = [];
  for (const st of stmts) {
    if (st.name === listName) continue;
    const using = exprs.filter((e) => refs2(e, st.name) > 0);
    if (!using.length) continue;
    if (!using.every((e) => new RegExp(`^\\{\\s*${st.name.replace(/\$/g, '\\$')}\\s*(&&|\\?)`).test(e.trim()))) {
      return refuse('page-one-section-not-optional', `The template uses "${st.name}" in a way that cannot simply be left out of pages 2 and up (it is not written as {${st.name} && (...)}), so the repeated section cannot be limited to page 1.`);
    }
    extras.push(st);
  }
  const usesGetCollection = closure.some((s) => /\bgetCollection\b/.test(fm.slice(s.exprStart, s.end)));

  const layout = firstComponentTag(text);
  if (!layout) return refuse('no-layout-tag', 'No layout component tag was found in the listing template.');
  const titleAttr = layout.attrs.find((a) => a.name === 'title');
  const descAttr = layout.attrs.find((a) => a.name === 'description');
  if (!titleAttr) return refuse('no-title-attr', 'The layout tag has no title attribute, so a unique title for each page cannot be made.');
  const title = literalOf(text, titleAttr);
  if (title == null) return refuse('title-not-literal', 'The layout title is not a plain string (it is an expression), so it cannot be varied per page safely.');
  const description = descAttr ? literalOf(text, descAttr) : null;
  if (descAttr && description == null) return refuse('description-not-literal', 'The layout description is not a plain string (it is an expression).');

  // Where the pager goes: right after the element whose only child is the list.
  const mapAt = bodyStart + maps[0].index;
  const mapEnd = bodyStart + skipBraces(body, maps[0].index);
  if (mapEnd < bodyStart) return refuse('unbalanced-list', 'The list expression in the template is not balanced.');
  const before = text.slice(0, mapAt);
  const open = /<([a-z][\w-]*)\b[^<>]*>\s*$/.exec(before);
  const close = open && new RegExp(`^\\s*</${open[1]}>`).exec(text.slice(mapEnd));
  if (!open || !close) return refuse('list-not-alone', 'The list is not the only thing inside its container element, so it is not clear where the pager belongs.');
  const pagerAt = mapEnd + close[0].length;

  // SEOAI content markers: wrapped to show on page 1 only.
  const markerRe = /<!--\s*SEOAI:[\w-]+:START\s*-->[\s\S]*?<!--\s*SEOAI:[\w-]+:END\s*-->/g;
  const markers = [...body.matchAll(markerRe)];
  let wrap = null;
  if (markers.length) {
    const first = markers[0];
    const last = markers[markers.length - 1];
    const between = body.slice(first.index, last.index + last[0].length).replace(markerRe, '');
    if (between.trim()) return refuse('markers-not-together', 'The SEOAI content markers are not in one group, so they cannot be limited to page 1 without moving them.');
    wrap = { from: bodyStart + first.index, to: bodyStart + last.index + last[0].length };
  }

  const split = (() => { const i = title.lastIndexOf(' | '); return i > 0 ? [title.slice(0, i), title.slice(i)] : [title, '']; })();
  const suffix = trailingSlash === 'always' ? '/' : '';
  const prelude = [
    `const pagerSize = ${pageSize};`,
    `const pagerPage = Number(Astro.props.pagerPage ?? 1);`,
    `const pagerTotal = Math.max(1, Math.ceil(${listName}All.length / pagerSize));`,
    `const ${listName} = ${listName}All.slice((pagerPage - 1) * pagerSize, pagerPage * pagerSize);`,
    `const pagerHref = (n) => (n <= 1 ? ${jsStr(noSlash + suffix)} : ${jsStr(noSlash)} + '/page/' + n + ${jsStr(suffix)});`,
    `const pagerMeta = pagerPage > 1 ? { title: ${jsStr(split[0])} + ', Page ' + pagerPage + ${jsStr(split[1])}${description != null ? `, description: ${jsStr(description)} + ' (Page ' + pagerPage + ')'` : ''} } : {};`,
  ];

  const edits = [];
  const declText = fm.slice(decl.start, decl.end);
  edits.push({ at: fmStart + decl.start, del: decl.exprStart - decl.start, ins: declText.slice(0, decl.exprStart - decl.start).replace(new RegExp(`(const\\s+)${listName.replace(/\$/g, '\\$')}`), `$1${listName}All`) });
  // Constants kept whole as NAMEAll (every declaration and use inside the frontmatter's code, never inside strings or comments) and exposed
  // under their old name on page 1 only. The prelude goes after the last statement involved so nothing is read before it is defined.
  const codeMask = new Uint8Array(fm.length).fill(0);
  scan(fm, (i) => { codeMask[i] = 1; return true; });
  for (const st of extras) {
    const re = new RegExp(`(?<![.\\w$])${st.name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
    for (const m of fm.matchAll(re)) if (codeMask[m.index]) edits.push({ at: fmStart + m.index, del: st.name.length, ins: `${st.name}All` });
    prelude.push(`const ${st.name} = pagerPage === 1 ? ${st.name}All : undefined;`);
  }
  const preludeAt = Math.max(decl.end, ...extras.map((x) => x.end));
  edits.push({ at: fmStart + preludeAt, del: 0, ins: eol + prelude.join(eol) });
  const endAt = layout.end - (text[layout.end - 2] === '/' ? 2 : 1);
  edits.push({ at: endAt, del: 0, ins: ' {...pagerMeta}' });
  const pagerLineStart = text.lastIndexOf('\n', mapAt) + 1;
  const pagerIndent = /^[ \t]*/.exec(text.slice(pagerLineStart))[0];
  edits.push({ at: pagerAt, del: 0, ins: eol + pagerMarkup(buttonClass, currentClass || buttonClass, 'pagerHref').split('\n').map((l) => `${pagerIndent}${l}`).join(eol) });
  if (wrap) {
    edits.push({ at: wrap.to, del: 0, ins: '</Fragment>)}' });
    edits.push({ at: wrap.from, del: 0, ins: '{pagerPage === 1 && (<Fragment>' });
  }
  let after = text;
  for (const e of edits.sort((a, b) => b.at - a.at)) after = after.slice(0, e.at) + e.ins + after.slice(e.at + e.del);

  const rel = posix.relative(posix.dirname(routePath), sourcePath).replace(/\.astro$/, '.astro');
  const importPath = rel.startsWith('.') ? rel : `./${rel}`;
  const routeSource = [
    '---',
    `// Pages 2 and up of the listing at ${basePath}: ${noSlash}/page/2, ${noSlash}/page/3, ... Page 1 is ${sourcePath}.`,
    '// Each one renders that same page, showing its own slice of the posts, so every page looks exactly like page 1.',
    `import Listing from '${importPath}';`,
    ...(usesGetCollection ? ["import { getCollection } from 'astro:content';"] : []),
    '',
    'export async function getStaticPaths() {',
    ...closure.map((s) => `  ${fm.slice(s.start, s.end).trim()}`),
    `  const total = Math.max(1, Math.ceil(${listName}.length / ${pageSize}));`,
    '  return Array.from({ length: total - 1 }, (_, i) => ({ params: { page: String(i + 2) }, props: { pagerPage: i + 2 } }));',
    '}',
    '',
    'const { pagerPage } = Astro.props;',
    '---',
    '<Listing pagerPage={pagerPage} />',
    '',
  ].join(eol);

  const notes = [
    `Paginates the list "${listName}" at ${pageSize} per page. Page 1 stays at ${basePath}; later pages are ${noSlash}/page/<n>, rendered by the new ${routePath} from the listing's own template.`,
    buttonClass ? `The pager reuses this site's own button classes: ${buttonClass}.` : "No button classes were available from the site's design profile, so the pager links are unstyled: style .blog-pager to match the site before merging.",
    'The existing title and description are left as they are; pages 2 and up get "…, Page N" added through a spread after them, so the setup automation that edits those values keeps working. The wording of pages 2+ is fixed to the current title and description.',
    wrap ? 'The SEOAI content markers now render on page 1 only.' : 'The listing has no SEOAI content markers.',
    extras.length ? `Sections driven by ${extras.map((x) => x.name).join(', ')} now show on page 1 only.` : 'Any hero or intro above the list is part of the template, so it repeats on every page.',
    'Check the layout builds its canonical tag from the page URL (Astro.url): a canonical fixed to the listing URL would point every page at page 1.',
  ];
  return { ok: true, after, extraFiles: [{ path: routePath, after: routeSource }], notes };
}
