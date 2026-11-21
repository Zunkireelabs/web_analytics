// The Next.js (App Router) recipe for paginating a blog listing.
//
// A page file cannot simply be re-rendered with an extra prop: `next build` type-checks a page's props and rejects anything but params and
// searchParams. So the listing's body moves, unchanged, into a shared component in the same folder, and two thin pages use it:
//
//   <dir>/page.tsx                  keeps its `metadata` export (byte for byte) and renders the shared component for page 1
//   <dir>/PaginatedListing.tsx      the old page body. Its list is cut to the page's slice, it gets a pager (the site's own button classes,
//                                   next/link) after the list's container, and the code that LOADS the posts becomes an exported function so the
//                                   page 2+ route can count them without copying anything
//   <dir>/page/[page]/page.tsx      pages 2..N: generateStaticParams, a unique title/description/canonical, the same component
//
// It works on a real syntax tree (@babel/parser), not on patterns, and REFUSES, with a specific reason, anything it cannot move safely:
// client components, pages with other exports, a list that is used in more than one place, a listing that takes props, and so on.
import { parse } from '@babel/parser';
import { posix } from 'node:path';

export const DEFAULT_PAGE_SIZE = 12;
const refuse = (reason, error) => ({ ok: false, reason, error });
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range']);
const GLOBALS = new Set(['undefined', 'NaN', 'Infinity', 'Date', 'Number', 'String', 'Boolean', 'Math', 'Object', 'Array', 'JSON', 'Promise', 'Set', 'Map']);

function walk(node, fn, parent = null, key = null) {
  if (!node || typeof node.type !== 'string') return;
  if (fn(node, parent, key) === false) return;
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, node, k));
    else if (v && typeof v.type === 'string') walk(v, fn, node, k);
  }
}

// Names an AST node reads as values: not property names, not object keys, not type annotations, not what a declaration introduces.
function referencedNames(node) {
  const out = new Set();
  walk(node, (n, parent, key) => {
    if (n.type.startsWith('TS')) return false;
    if (n.type !== 'Identifier') return true;
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return true;
    if (parent?.type === 'OptionalMemberExpression' && key === 'property' && !parent.computed) return true;
    if (parent?.type === 'ObjectProperty' && key === 'key' && !parent.computed && !parent.shorthand) return true;
    if (parent?.type === 'VariableDeclarator' && key === 'id') return true;
    out.add(n.name);
    return true;
  });
  return out;
}

const jsStr = (s) => JSON.stringify(String(s));

function literalString(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}
const prop = (obj, name) => obj?.properties?.find((p) => p.type === 'ObjectProperty' && !p.computed && (p.key.name === name || p.key.value === name));

function pagerJsx(linkName, btn, cur) {
  const b = btn ? ` className=${jsStr(btn)}` : '';
  const c = cur ? ` className=${jsStr(cur)}` : '';
  return [
    '{pagerTotal > 1 && (',
    '<nav className="blog-pager" aria-label="Blog pages" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center", justifyContent: "center", margin: "2rem 0" }}>',
    `  {pagerPage > 1 && <${linkName}${b} href={pagerHref(pagerPage - 1)} rel="prev">Newer posts</${linkName}>}`,
    `  {Array.from({ length: pagerTotal }, (_, i) => i + 1).map((n) => n === pagerPage ? <span key={n}${c} aria-current="page">{n}</span> : <${linkName} key={n}${b} href={pagerHref(n)}>{n}</${linkName}>)}`,
    `  {pagerPage < pagerTotal && <${linkName}${b} href={pagerHref(pagerPage + 1)} rel="next">Older posts</${linkName}>}`,
    '</nav>',
    ')}',
  ].join('\n');
}

/**
 * @param {{ source: string, sourcePath: string, basePath: string, pageSize?: number, buttonClass?: string|null, currentClass?: string|null,
 *           trailingSlash?: boolean, nextMajor?: number, existingFiles?: string[] }} p
 * @returns {{ ok: true, after: string, extraFiles: {path:string, after:string}[], notes: string[] } | { ok: false, reason: string, error: string }}
 */
export function planNextjsPagination({ source, sourcePath, basePath, pageSize = DEFAULT_PAGE_SIZE, buttonClass = null, currentClass = null, trailingSlash = false, nextMajor = 15, existingFiles = [] }) {
  const text = String(source ?? '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const loc = /^((?:src\/)?app(?:\/[^/]+)*?)\/page\.(tsx|jsx|ts|js)$/.exec(sourcePath || '');
  if (!loc) return refuse('not-an-app-router-page', `${sourcePath} is not an App Router page (app/.../page.tsx), the only Next.js layout this recipe handles.`);
  const dir = loc[1];
  const ext = loc[2];
  const ts = ext === 'tsx' || ext === 'ts';
  const urlDir = dir.replace(/^(?:src\/)?app/, '').split('/').filter((s) => s && !/^\(.*\)$/.test(s));
  if (urlDir.some((s) => /[\[\]@]/.test(s))) return refuse('dynamic-route', `${sourcePath} sits in a dynamic or parallel route, so its listing URL cannot be paginated by a fixed page/[page] route.`);
  const noSlash = (basePath || '').replace(/\/+$/, '');
  if (!noSlash || noSlash !== `/${urlDir.join('/')}`) return refuse('route-mismatch', `${sourcePath} does not serve ${basePath}.`);
  const sharedPath = `${dir}/PaginatedListing.${ts ? 'tsx' : 'jsx'}`;
  const routePath = `${dir}/page/[page]/page.${ts ? 'tsx' : 'jsx'}`;
  if (existingFiles.includes(routePath) || existingFiles.some((f) => /^.*\/page\/\[page\]\/page\./.test(f) && f.startsWith(`${dir}/page/`))) return refuse('route-exists', `${routePath} already exists, so this listing may already be paginated.`);
  if (existingFiles.includes(sharedPath)) return refuse('shared-exists', `${sharedPath} already exists.`);
  if (/\b(pagerPage|pagerTotal|pagerHref|loadListing|PAGE_SIZE|PaginatedListing)\b/.test(text)) return refuse('names-in-use', 'The page already uses names this recipe needs (pagerPage, pagerTotal, pagerHref, loadListing, PAGE_SIZE, PaginatedListing).');

  let ast;
  try { ast = parse(text, { sourceType: 'module', plugins: ts ? ['typescript', 'jsx'] : ['jsx'] }); } catch (e) { return refuse('unparseable', `The page could not be read as ${ts ? 'TypeScript' : 'JavaScript'} + JSX (${String(e.message).split('\n')[0]}).`); }
  const prog = ast.program;
  if (prog.directives?.some((d) => d.value.value === 'use client')) return refuse('client-component', 'The page is a client component ("use client"), which cannot load its posts on the server or export metadata. This recipe does not rewrite it.');

  const imports = prog.body.filter((n) => n.type === 'ImportDeclaration');
  let metaStmt = null, defaultExport = null;
  for (const n of prog.body) {
    if (n.type === 'ExportDefaultDeclaration') defaultExport = n;
    else if (n.type === 'ExportNamedDeclaration') {
      const d = n.declaration;
      if (d?.type === 'VariableDeclaration' && d.declarations.length === 1 && d.declarations[0].id.name === 'metadata') metaStmt = n;
      else return refuse('other-exports', 'The page exports something besides `metadata` and its component (generateMetadata, revalidate, dynamic, ...). Those settings would have to be repeated on the new pages, so this recipe does not rewrite it.');
    }
  }
  const fn = defaultExport?.declaration;
  if (fn?.type !== 'FunctionDeclaration' || !fn.id) return refuse('no-default-function', 'The page does not export a named default function component.');
  if (fn.params.length) return refuse('page-takes-props', 'The page component takes props (params or searchParams), which this recipe does not rewrite.');
  if (fn.generator) return refuse('generator-page', 'The page component is a generator.');
  const body = fn.body.body;

  // The list: the one identifier in `{X.map(...)}` inside the returned JSX.
  const mapCalls = [];
  walk(fn.body, (n, parent) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'map' && n.callee.object.type === 'Identifier' && parent?.type === 'JSXExpressionContainer') mapCalls.push({ node: n, container: parent });
  });
  if (!mapCalls.length) return refuse('no-list-map', 'No `{list.map(...)}` over a constant of the page was found, so its posts come from somewhere this recipe cannot paginate (a component, hand-written cards, a client-side list).');
  const listName = mapCalls[0].node.callee.object.name;
  if (mapCalls.some((m) => m.node.callee.object.name !== listName) || mapCalls.length > 1) return refuse('several-lists', 'The page maps over more than one list (or the same one in more than one place), so it is not clear which is the blog post list.');

  // Body statements that declare a single plain constant: name -> statement.
  const declOf = new Map();
  for (const st of body) {
    if (st.type === 'VariableDeclaration' && st.kind === 'const' && st.declarations.length === 1 && st.declarations[0].id.type === 'Identifier' && st.declarations[0].init) declOf.set(st.declarations[0].id.name, st);
  }
  if (!declOf.has(listName)) return refuse('list-not-a-const', `${listName} is not a plain const of the page function, so it cannot be sliced.`);
  const stmtRefs = (st) => referencedNames(st.declarations[0].init);

  // The statements the list is computed from (transitively): they become the exported loader.
  const closure = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    const st = declOf.get(name);
    if (!st) return true;
    for (const id of stmtRefs(st)) if (declOf.has(id) && !visit(id)) return false;
    closure.push(st);
    return true;
  };
  visit(listName);
  closure.sort((a, b) => a.start - b.start);
  const closureNames = closure.map((s) => s.declarations[0].id.name);
  const inClosure = new Set(closure);
  const outside = body.filter((s) => !inClosure.has(s));
  const refsOutside = new Set();
  for (const s of outside) for (const n of referencedNames(s)) refsOutside.add(n);
  // A list cut to its first few items in the page itself (`posts.slice(0, 6)`) is a teaser, not the blog's list: the rest of the posts are shown
  // some other way (a client-side "load more", another section), so paginating this list would change nothing for them. Skipping items from the
  // front (`posts.slice(1)`, to leave out a featured post) is fine.
  const listInit = text.slice(declOf.get(listName).declarations[0].init.start, declOf.get(listName).declarations[0].init.end);
  if (/\.slice\(\s*[^,()]+,\s*[^)]+\)/.test(listInit)) return refuse('list-is-truncated', `${listName} is cut to its first few posts inside the page (${listInit.match(/\.slice\([^)]*\)/)[0]}), so it is a teaser rather than the full list of posts. The other posts are shown some other way (a "load more" component, another section), and paginating this list would not cover them.`);

  // The list must be read exactly once outside its own definition: by the `.map` that renders it.
  let listReads = 0;
  for (const st of outside) walk(st, (n, parent, key) => {
    if (n.type.startsWith('TS')) return false;
    if (n.type === 'Identifier' && n.name === listName && !(parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) && !(parent?.type === 'ObjectProperty' && key === 'key' && !parent.computed && !parent.shorthand)) listReads++;
    return true;
  });
  if (listReads !== 1) return refuse('list-used-elsewhere', `${listName} is used elsewhere in the page, so replacing it with a slice would change other parts of it.`);

  // Constants the JSX shows only when present (a "featured" post): page 1 only. Safe only when the JSX already treats them as optional
  // (`{n && (...)}` or `{n ? ... : ...}`); a constant the JSX uses any other way is left alone, shown on every page like the rest of the page.
  const extras = [];
  for (const n of declOf.keys()) {
    if (n === listName) continue;
    let uses = 0, optional = 0;
    walk(fn.body, (x) => {
      if (x.type === 'JSXExpressionContainer' && referencedNames(x).has(n)) {
        uses++;
        const e = x.expression;
        if ((e.type === 'LogicalExpression' && e.operator === '&&' && e.left.type === 'Identifier' && e.left.name === n) || (e.type === 'ConditionalExpression' && e.test.type === 'Identifier' && e.test.name === n)) optional++;
        return false;   // what is inside is covered by this outermost expression
      }
      return true;
    });
    if (!uses) continue;
    if (uses !== optional) {
      // used some other way: only a problem when it is derived from the posts (it would then repeat on every page); a plain constant is fine
      if ([...stmtRefs(declOf.get(n))].some((r) => closureNames.includes(r))) return refuse('page-one-section-not-optional', `The page uses "${n}", which is computed from the posts, in a way that cannot simply be left out of pages 2 and up (it is not written as {${n} && (...)}), so the repeated section cannot be limited to page 1.`);
      continue;
    }
    if (outside.some((st) => st !== declOf.get(n) && st.type !== 'ReturnStatement' && referencedNames(st).has(n))) return refuse('page-one-section-not-optional', `"${n}" is also used by other statements, so it cannot be limited to page 1 safely.`);
    extras.push(n);
  }

  // Metadata: copied verbatim to page.tsx; for pages 2+ the title/description/canonical are derived from its plain literals.
  let metaTitle = null, metaDesc = null, origin = null;
  if (metaStmt) {
    const obj = metaStmt.declaration.declarations[0].init;
    if (obj?.type !== 'ObjectExpression') return refuse('metadata-not-literal', 'The page `metadata` is not a plain object.');
    let free = false;
    for (const id of referencedNames(obj)) if (!GLOBALS.has(id)) free = true;
    if (free) return refuse('metadata-uses-imports', 'The page `metadata` reads values from imports or variables, so it cannot be copied to the new page and varied per page.');
    const t = prop(obj, 'title');
    metaTitle = literalString(t?.value);
    if (metaTitle == null) return refuse('title-not-plain', 'The page metadata title is not a plain string, so a unique title for each page cannot be made.');
    const d = prop(obj, 'description');
    if (d) { metaDesc = literalString(d.value); if (metaDesc == null) return refuse('description-not-plain', 'The page metadata description is not a plain string.'); }
    const canon = literalString(prop(prop(obj, 'alternates')?.value, 'canonical')?.value);
    if (canon) { try { origin = new URL(canon).origin; } catch { origin = null; } }
  } else return refuse('no-metadata', 'The page has no `export const metadata`, so a unique title for each page cannot be made.');

  // The pager goes after the element whose only child is the list.
  const parentOf = new Map();
  walk(fn.body, (n, parent) => { parentOf.set(n, parent); });
  const containerEl = parentOf.get(mapCalls[0].container);
  const kids = containerEl?.type === 'JSXElement' ? containerEl.children.filter((c) => !(c.type === 'JSXText' && !c.value.trim())) : [];
  if (containerEl?.type !== 'JSXElement' || kids.length !== 1) return refuse('list-not-alone', 'The list is not the only thing inside its container element, so it is not clear where the pager belongs.');
  const outer = parentOf.get(containerEl);
  if (outer?.type !== 'JSXElement' && outer?.type !== 'JSXFragment') return refuse('list-container-is-root', 'The list container is the root element of the page, so there is nowhere beside it for the pager.');

  // next/link, for the pager (a plain <a> to an internal page is rejected by Next's lint).
  const linkImport = imports.find((i) => i.source.value === 'next/link');
  const linkSpec = linkImport?.specifiers.find((s) => s.type === 'ImportDefaultSpecifier');
  const linkName = linkSpec?.local.name || 'Link';
  if (!linkSpec) {
    let taken = false;
    walk(prog, (n) => { if ((n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') && n.local.name === 'Link') taken = true; });
    if (taken) return refuse('link-name-taken', 'The name "Link" is already imported from somewhere else in the page.');
  }

  // SEOAI content markers inside the component: shown on page 1 only.
  const bodyText = text.slice(fn.body.start, fn.body.end);
  const markerRe = /\{\/\*\s*SEOAI:[\w-]+:START\s*\*\/\}[\s\S]*?\{\/\*\s*SEOAI:[\w-]+:END\s*\*\/\}/g;
  const markers = [...bodyText.matchAll(markerRe)];
  let wrap = null;
  if (markers.length) {
    const first = markers[0], last = markers[markers.length - 1];
    if (bodyText.slice(first.index, last.index + last[0].length).replace(markerRe, '').trim()) return refuse('markers-not-together', 'The SEOAI content markers are not in one group, so they cannot be limited to page 1 without moving them.');
    wrap = { from: fn.body.start + first.index, to: fn.body.start + last.index + last[0].length };
  }

  // ── the shared component: the old file, edited ──
  const lineEndAfter = (i) => { const nl = text.indexOf('\n', i); return nl < 0 ? text.length : nl + 1; };
  const edits = [];
  edits.push({ at: metaStmt.start, del: lineEndAfter(metaStmt.end) - metaStmt.start, ins: '' });
  for (const imp of imports) {
    if (imp.source.value === 'next' && imp.specifiers.length === 1 && imp.specifiers[0].local.name === 'Metadata') edits.push({ at: imp.start, del: lineEndAfter(imp.end) - imp.start, ins: '' });
  }
  if (!linkSpec) { const lastImp = imports[imports.length - 1]; edits.push({ at: lineEndAfter(lastImp.end), del: 0, ins: `import Link from "next/link";${eol}` }); }
  // signature
  const sigParamsAt = text.indexOf('(', fn.id.end);
  edits.push({ at: sigParamsAt, del: text.indexOf(')', sigParamsAt) + 1 - sigParamsAt, ins: ts ? '({ pagerPage = 1 }: { pagerPage?: number })' : '({ pagerPage = 1 })' });
  if (!fn.async) edits.push({ at: fn.start, del: 0, ins: 'async ' });
  // closure -> loader
  const closureText = closure.map((s) => `  ${text.slice(s.start, s.end)}`).join(eol);
  const loaderAt = defaultExport.start;
  edits.push({ at: loaderAt, del: 0, ins: `export const PAGE_SIZE = ${pageSize};${eol}${eol}export async function loadListing() {${eol}${closureText}${eol}  return { ${closureNames.join(', ')} };${eol}}${eol}${eol}` });
  const need = closureNames.filter((n) => n === listName || extras.includes(n) || refsOutside.has(n));  // extras outside the closure are renamed in place instead
  const destructure = need.map((n) => (n === listName || extras.includes(n) ? `${n}: ${n}All` : n)).join(', ');
  const suffix = trailingSlash ? '/' : '';
  const prelude = [
    `const { ${destructure} } = await loadListing();`,
    `const pagerTotal = Math.max(1, Math.ceil(${listName}All.length / PAGE_SIZE));`,
    `const ${listName} = ${listName}All.slice((pagerPage - 1) * PAGE_SIZE, pagerPage * PAGE_SIZE);`,
    ...extras.filter((n) => closureNames.includes(n)).map((n) => `const ${n} = pagerPage === 1 ? ${n}All : undefined;`),
    `const pagerHref = (n${ts ? ': number' : ''}) => (n <= 1 ? ${jsStr(noSlash + suffix)} : ${jsStr(noSlash)} + "/page/" + n + ${jsStr(suffix)});`,
  ].map((l) => `  ${l}`).join(eol);
  // Each closure statement is removed with its whole line; the first is replaced by the destructure and the prelude.
  closure.forEach((s, i) => {
    let from = s.start;
    while (from > 0 && /[ \t]/.test(text[from - 1])) from--;
    edits.push({ at: from, del: lineEndAfter(s.end) - from, ins: i === 0 ? `${prelude}${eol}` : '' });
  });
  for (const n of extras.filter((x) => !closureNames.includes(x))) {
    const st = declOf.get(n);
    const id = st.declarations[0].id;
    edits.push({ at: id.start, del: id.end - id.start, ins: `${n}All` });
    edits.push({ at: lineEndAfter(st.end), del: 0, ins: `  const ${n} = pagerPage === 1 ? ${n}All : undefined;${eol}` });
  }
  // pager after the container; markers wrapped
  const lineStart = text.lastIndexOf('\n', containerEl.start) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))[0];
  const pager = pagerJsx(linkName, buttonClass, currentClass || buttonClass).split('\n').map((l) => `${indent}${l}`).join(eol);
  edits.push({ at: containerEl.end, del: 0, ins: `${eol}${pager}` });
  if (wrap) { edits.push({ at: wrap.to, del: 0, ins: '</>)}' }); edits.push({ at: wrap.from, del: 0, ins: '{pagerPage === 1 && (<>' }); }
  let shared = text;
  for (const e of edits.sort((a, b) => b.at - a.at)) shared = shared.slice(0, e.at) + e.ins + shared.slice(e.at + e.del);
  // statements removed from the body must not be left as blank runs
  shared = shared.replace(/\n{3,}/g, '\n\n');

  // ── page.tsx: metadata untouched, renders the shared component ──
  const metaText = text.slice(metaStmt.start, metaStmt.end);
  const metaImport = imports.find((i) => i.source.value === 'next' && i.specifiers.some((s) => s.local.name === 'Metadata'));
  const page = [
    ...(metaImport ? [text.slice(metaImport.start, metaImport.end)] : []),
    'import PaginatedListing from "./PaginatedListing";',
    '',
    metaText,
    '',
    `export default async function ${fn.id.name}() {`,
    '  return <PaginatedListing pagerPage={1} />;',
    '}',
    '',
  ].join(eol);

  // ── pages 2..N ──
  const split = (() => { const i = metaTitle.lastIndexOf(' | '); return i > 0 ? [metaTitle.slice(0, i), metaTitle.slice(i)] : [metaTitle, '']; })();
  const asyncParams = nextMajor >= 15;
  const paramsType = asyncParams ? '{ params: Promise<{ page: string }> }' : '{ params: { page: string } }';
  const getPage = asyncParams ? '  const { page } = await params;' : '  const { page } = params;';
  const route = [
    ...(ts ? ['import type { Metadata } from "next";'] : []),
    'import PaginatedListing, { PAGE_SIZE, loadListing } from "../../PaginatedListing";',
    '',
    '// Pages 2 and up of the listing: the same component as page 1, showing its own slice of the posts.',
    'export async function generateStaticParams() {',
    `  const { ${listName} } = await loadListing();`,
    `  const total = Math.max(1, Math.ceil(${listName}.length / PAGE_SIZE));`,
    '  return Array.from({ length: total - 1 }, (_, i) => ({ page: String(i + 2) }));',
    '}',
    '',
    `export async function generateMetadata({ params }${ts ? `: ${paramsType}` : ''})${ts ? ': Promise<Metadata>' : ''} {`,
    getPage,
    '  return {',
    `    title: ${jsStr(split[0])} + ", Page " + page + ${jsStr(split[1])},`,
    ...(metaDesc != null ? [`    description: ${jsStr(metaDesc)} + " (Page " + page + ")",`] : []),
    ...(origin ? [`    alternates: { canonical: ${jsStr(origin + noSlash)} + "/page/" + page + ${jsStr(suffix)} },`] : []),
    '  };',
    '}',
    '',
    `export default async function Page({ params }${ts ? `: ${paramsType}` : ''}) {`,
    getPage,
    '  return <PaginatedListing pagerPage={Number(page)} />;',
    '}',
    '',
  ].join(eol);

  const notes = [
    `Paginates the list "${listName}" at ${pageSize} per page. Page 1 stays at ${basePath}; later pages are ${noSlash}/page/<n>.`,
    `The page body moved, unchanged apart from the slice and the pager, into ${sharedPath}; ${sourcePath} keeps its metadata and renders it. The code that loads the posts is now the exported loadListing() there, so the new pages count the posts the same way.`,
    buttonClass ? `The pager reuses this site's own button classes: ${buttonClass}.` : "No button classes were available from the site's design profile, so the pager links are unstyled: style .blog-pager to match the site before merging.",
    origin ? 'Pages 2+ get their own title, description and canonical; other metadata (Open Graph, ...) is not repeated on them.' : 'The page metadata has no canonical URL, so pages 2+ are given none: add one in the layout if the site uses canonicals.',
    extras.length ? `Sections driven by ${extras.join(', ')} now show on page 1 only.` : 'Any hero or intro above the list is part of the page, so it repeats on every page.',
    wrap ? 'The SEOAI content markers now render on page 1 only.' : 'The page has no SEOAI content markers.',
    ...(nextMajor >= 15 ? [] : ['Written for Next.js 14 or older: route params are read synchronously.']),
  ];
  return { ok: true, after: page, extraFiles: [{ path: sharedPath, after: shared }, { path: routePath, after: route }], notes };
}
