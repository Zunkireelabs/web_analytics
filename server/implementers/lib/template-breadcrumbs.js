// BREADCRUMBS FOR A SHARED TEMPLATE, ANY STACK.
//
// One template file renders many URLs (Next.js src/app/category/[slug]/page.tsx, Astro src/pages/blog/[slug].astro, an Eleventy
// pagination include). A static trail written into it would show one page's breadcrumbs on all of them, so the file is edited ONCE to
// build the trail from what the template already knows about the page it is rendering. Each stack has an ADAPTER below that knows how
// that stack exposes the current page and where its markup starts; the rules are the same for all of them:
//   - the page's address comes from the stack (route parameter / Astro.url / Eleventy page.url), never from a literal page;
//   - the page's name comes from the heading the template already shows (<h1>{name}</h1>), never invented;
//   - if either cannot be found in the file, refuse with a reason (needs-input) instead of guessing a variable;
//   - already-present breadcrumbs are an idempotent no-op; nothing visible is added (a schema-only <script>).
// Original description (Next.js, the first adapter):
//
// One route file (Next.js app router: src/app/category/[slug]/page.tsx) renders many URLs. A static trail written into it would show
// one page's breadcrumbs on all of them, so the file is edited ONCE to build the trail from what the template already knows about the
// page it is rendering: the route parameter (`slug`) for the URL and the heading it already shows (`<h1>{categoryName}</h1>`) for the name.
// Nothing is invented and nothing is page-specific: a new page that uses the template gets its own correct trail automatically.
//
// Self-contained (a plain <script type="application/ld+json">, no import), so it needs no component to exist in the client's repo.
// Refuses, with a reason, whenever it cannot find those two facts in the file: it never guesses a variable.
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const H1_EXPR_RE = new RegExp(String.raw`<h1\b[^>]*>\s*\{\s*(${IDENT}(?:\??\.${IDENT})*)\s*\}\s*</h1>`);
const MAIN_OPEN_RE = /<main\b[^>]*>/;

const alreadyHasBreadcrumbs = (src) => /BreadcrumbList|<BreadcrumbSchema\b|\bbreadcrumbSchema\s*\(/.test(src);
const safeOrigin = (o) => /^https?:\/\/[^\s"'`\\${}]+$/.test(o || '');

// Index just past the '>' that closes the opening tag starting at `start`, skipping '>' inside {expressions} and quoted values
// (`<Layout title={a >= b ? x : y}>`). null when it never closes.
export function endOfOpeningTag(src, start) {
  let depth = 0; let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (depth > 0 && (c === '"' || c === "'" || c === '`')) { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (depth === 0 && c === '>') return i + 1;
  }
  return null;
}


/** "src/app/category/[slug]/page.tsx" -> { urlTemplate: "/category/${slug}", params: ["slug"], pathRegex } ; null if not an app-router page file. */
export function routeFromAppFile(filePath) {
  const m = /(?:^|\/)app\/(.*)\/page\.(?:tsx|jsx|ts|js)$/.exec(String(filePath || ''));
  if (!m) return null;
  const parts = m[1].split('/').filter((p) => p && !/^\(.*\)$/.test(p)); // route groups (x) are not in the URL
  if (parts.some((p) => /^\[\[?\.\.\./.test(p))) return null; // catch-all routes: the trail depth is unknown
  const params = [];
  const urlTemplate = `/${parts.map((p) => { const b = /^\[([A-Za-z_$][\w$]*)\]$/.exec(p); if (b) { params.push(b[1]); return `\${${b[1]}}`; } return p; }).join('/')}`;
  const pathRegex = new RegExp(`^/${parts.map((p) => (/^\[[^\]]+\]$/.test(p) ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`);
  return { urlTemplate, params, pathRegex };
}

/**
 * @param {string} source   the template file's current source
 * @param {{ filePath: string, origin: string, pagePath: string }} ctx   origin like "https://example.com"; pagePath is the path of a real page using it
 * @returns {{ ok: true, newContent: string, changedRegion: {before:string, after:string} } | { ok: false, reason: string, error: string }}
 */
function injectNextAppRouter(source, { filePath, origin, pagePath }) {
  if (alreadyHasBreadcrumbs(source)) {
    return { ok: false, reason: 'already-applied', error: 'This template already emits a BreadcrumbList — nothing to do.' };
  }
  const route = routeFromAppFile(filePath);
  if (!route) return { ok: false, reason: 'needs-input:template-not-app-router', error: `${filePath} is not a Next.js app-router page file, so the trail cannot be built from its route.` };
  if (pagePath && !route.pathRegex.test(pagePath)) {
    return { ok: false, reason: 'needs-input:template-route-mismatch', error: `${filePath} does not render ${pagePath}.` };
  }
  if (!/^https?:\/\/[^\s"'`\\${}]+$/.test(origin || '')) return { ok: false, reason: 'needs-input:bad-origin', error: 'The site origin is not a plain http(s) origin.' };

  // Every route parameter in the URL must be a variable the template actually has in scope.
  for (const p of route.params) {
    const inScope = new RegExp(String.raw`\bconst\s*\{[^}]*\b${p}\b[^}]*\}\s*=\s*(?:await\s+)?(?:props\.)?params\b|\bparams\.${p}\b`).test(source);
    if (!inScope) return { ok: false, reason: 'needs-input:route-param-not-in-scope', error: `The template does not read the route parameter "${p}" (no \`const { ${p} } = await params\`), so the page address cannot be built from it.` };
  }

  const h1 = H1_EXPR_RE.exec(source);
  if (!h1) return { ok: false, reason: 'needs-input:no-heading-variable', error: 'The template\'s <h1> is not a plain variable (for example {categoryName}), so the page\'s own name cannot be read from it.' };
  const nameExpr = h1[1];
  const root = nameExpr.split(/\??\./)[0];
  if (!new RegExp(String.raw`\b(?:const|let)\s+${root.replace(/\$/g, '\\$')}\b|\b(?:const|let)\s*\{[^}]*\b${root.replace(/\$/g, '\\$')}\b`).test(source)) {
    return { ok: false, reason: 'needs-input:heading-variable-not-declared', error: `The heading variable "${root}" is not declared in this file.` };
  }

  const main = MAIN_OPEN_RE.exec(source);
  if (!main) return { ok: false, reason: 'needs-input:no-main-element', error: 'No <main> element found to place the trail in.' };
  const lineStart = source.lastIndexOf('\n', main.index) + 1;
  const indent = /^\s*/.exec(source.slice(lineStart, main.index))[0] + '  ';
  const block = [
    `${indent}{/* Breadcrumb trail for every page this template renders: the address comes from the route parameter and the name from the`,
    `${indent}    heading shown below, so each page gets its own trail. Schema only; nothing visible is added. */}`,
    `${indent}<script`,
    `${indent}  type="application/ld+json"`,
    `${indent}  dangerouslySetInnerHTML={{`,
    `${indent}    __html: JSON.stringify({`,
    `${indent}      "@context": "https://schema.org",`,
    `${indent}      "@type": "BreadcrumbList",`,
    `${indent}      itemListElement: [`,
    `${indent}        { "@type": "ListItem", position: 1, name: "Home", item: "${origin}/" },`,
    `${indent}        { "@type": "ListItem", position: 2, name: ${nameExpr}, item: \`${origin}${route.urlTemplate}\` },`,
    `${indent}      ],`,
    `${indent}    }),`,
    `${indent}  }}`,
    `${indent}/>`,
  ].join('\n');
  const at = main.index + main[0].length;
  const newContent = `${source.slice(0, at)}\n${block}${source.slice(at)}`;
  return { ok: true, newContent, changedRegion: { before: main[0], after: `${main[0]}\n${block}` }, route: { urlTemplate: route.urlTemplate, nameExpr } };
}

/** The block as it stands in a file, for the live view. */
export function hasTemplateBreadcrumbs(source) {
  return /BreadcrumbList/.test(source || '');
}


// ---------------------------------------------------------------------------------------------------------------------------------
// ASTRO: src/pages/**/[param].astro. Astro gives every page its own URL (Astro.url), so no route-parameter parsing is needed; the name
// is the heading variable, which must be declared in the frontmatter. Placed as the first child of <main>, else of the first wrapping
// component (<Layout ...>), else at the top of the markup.
const ASTRO_PAGE_RE = /(?:^|\/)src\/pages\/(.*)\.astro$/;
export function routeFromAstroFile(filePath) {
  const m = ASTRO_PAGE_RE.exec(String(filePath || ''));
  if (!m) return null;
  const parts = m[1].split('/').filter(Boolean);
  if (parts.at(-1) === 'index') parts.pop();
  if (!parts.some((p) => /^\[[^.\]]+\]$/.test(p))) return null; // not a dynamic route: a per-page file, not a shared template
  if (parts.some((p) => /^\[\.\.\./.test(p))) return null;
  return { pathRegex: new RegExp(`^/${parts.map((p) => (/^\[[^\]]+\]$/.test(p) ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`) };
}

function injectAstro(source, { filePath, origin, pagePath }) {
  if (alreadyHasBreadcrumbs(source)) return { ok: false, reason: 'already-applied', error: 'This template already emits a BreadcrumbList — nothing to do.' };
  const route = routeFromAstroFile(filePath);
  if (!route) return { ok: false, reason: 'needs-input:template-not-astro-dynamic-page', error: `${filePath} is not an Astro dynamic page.` };
  if (pagePath && !route.pathRegex.test(pagePath)) return { ok: false, reason: 'needs-input:template-route-mismatch', error: `${filePath} does not render ${pagePath}.` };
  if (!safeOrigin(origin)) return { ok: false, reason: 'needs-input:bad-origin', error: 'The site origin is not a plain http(s) origin.' };
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(source);
  if (!fm) return { ok: false, reason: 'needs-input:no-frontmatter', error: 'The Astro page has no frontmatter block.' };
  const markupStart = fm[0].length;
  const markup = source.slice(markupStart);
  const h1 = H1_EXPR_RE.exec(markup);
  if (!h1) return { ok: false, reason: 'needs-input:no-heading-variable', error: 'The template\'s <h1> is not a plain variable (for example {title}), so the page\'s own name cannot be read from it.' };
  const nameExpr = h1[1];
  const root = nameExpr.split(/\??\./)[0].replace(/\$/g, '\\$');
  if (!new RegExp(String.raw`\b(?:const|let)\s+${root}\b|\b(?:const|let)\s*\{[^}]*\b${root}\b`).test(fm[1])) {
    return { ok: false, reason: 'needs-input:heading-variable-not-declared', error: `The heading variable "${nameExpr.split(/\??\./)[0]}" is not declared in the page's frontmatter.` };
  }
  // where: first child of <main>, else of the first wrapping component, else the top of the markup
  let at = markupStart; let indent = '';
  const main = MAIN_OPEN_RE.exec(markup);
  const comp = /<([A-Z][\w.]*)\b/.exec(markup);
  const anchor = main || comp;
  if (anchor) {
    const end = endOfOpeningTag(markup, anchor.index);
    if (end == null) return { ok: false, reason: 'needs-input:unclosed-opening-tag', error: 'Could not find where the page\'s first wrapping tag ends.' };
    if (!/\/>\s*$/.test(markup.slice(anchor.index, end))) { at = markupStart + end; const ls = markup.lastIndexOf('\n', anchor.index) + 1; indent = `${/^\s*/.exec(markup.slice(ls, anchor.index))[0]}  `; }
  }
  const block = [
    `${indent}{/* Breadcrumb trail for every page this template renders: the address is the page's own URL and the name is the heading`,
    `${indent}    shown below. Schema only; nothing visible is added. */}`,
    `${indent}<script type="application/ld+json" set:html={JSON.stringify({`,
    `${indent}  "@context": "https://schema.org",`,
    `${indent}  "@type": "BreadcrumbList",`,
    `${indent}  itemListElement: [`,
    `${indent}    { "@type": "ListItem", position: 1, name: "Home", item: "${origin}/" },`,
    `${indent}    { "@type": "ListItem", position: 2, name: ${nameExpr}, item: new URL(Astro.url.pathname.replace(/(?:\\/index)?\\.html$/, ""), "${origin}").href },`,
    `${indent}  ],`,
    `${indent}})} />`,
  ].join('\n');
  const lead = at === markupStart && !anchor ? '' : '\n';
  const newContent = `${source.slice(0, at)}${lead}${block}${at === markupStart && !anchor ? '\n' : ''}${source.slice(at)}`;
  return { ok: true, newContent, changedRegion: { before: '', after: block }, route: { nameExpr } };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ELEVENTY / NUNJUCKS: .njk templates and includes. Eleventy gives every generated page `page.url`, so the address is `page.url`; the
// name is the heading variable `<h1>{{ name }}</h1>`. The origin uses the site's own `site.url` when the file already uses it (so dev and
// production stay correct), else the literal origin. Inserted after the front matter, or at the top of an include.
const NJK_H1_RE = /<h1\b[^>]*>\s*\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)\s*(?:\|\s*(?:safe|striptags|escape|trim)\s*)*\}\}\s*<\/h1>/;

function injectEleventyNjk(source, { filePath, origin }) {
  if (alreadyHasBreadcrumbs(source)) return { ok: false, reason: 'already-applied', error: 'This template already emits a BreadcrumbList — nothing to do.' };
  if (!/\.njk$/i.test(filePath)) return { ok: false, reason: 'needs-input:template-not-njk', error: `${filePath} is not a Nunjucks template.` };
  const h1 = NJK_H1_RE.exec(source);
  if (!h1) return { ok: false, reason: 'needs-input:no-heading-variable', error: 'The template\'s <h1> is not a plain variable (for example {{ feature.name }}), so the page\'s own name cannot be read from it.' };
  const useSiteUrl = /\bsite\.url\b/.test(source);
  if (!useSiteUrl && !safeOrigin(origin)) return { ok: false, reason: 'needs-input:bad-origin', error: 'The site origin is not a plain http(s) origin.' };
  const base = useSiteUrl ? 'site.url' : `"${origin}"`;
  const fm = /^---\s*\n[\s\S]*?\n---\s*\n/.exec(source);
  const at = fm ? fm[0].length : 0;
  const block = [
    '{# Breadcrumb trail for every page this template renders: the address is the page\'s own URL (page.url) and the name is the heading',
    '   shown below. Schema only; nothing visible is added. #}',
    `<script type="application/ld+json">{{ { "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [ { "@type": "ListItem", "position": 1, "name": "Home", "item": ${base} + "/" }, { "@type": "ListItem", "position": 2, "name": ${h1[1]} | striptags, "item": ${base} + page.url } ] } | dump | safe }}</script>`,
    '',
  ].join('\n');
  return { ok: true, newContent: `${source.slice(0, at)}${block}${source.slice(at)}`, changedRegion: { before: '', after: block }, route: { nameExpr: h1[1] } };
}

// ---------------------------------------------------------------------------------------------------------------------------------
const ADAPTERS = [
  { id: 'next-app-router', supports: (f) => routeFromAppFile(f) != null, inject: injectNextAppRouter },
  { id: 'astro', supports: (f) => routeFromAstroFile(f) != null, inject: injectAstro },
  { id: 'eleventy-njk', supports: (f) => /\.njk$/i.test(String(f || '')), inject: injectEleventyNjk },
];

/** Which stack adapter handles this template file, or null. */
export function templateBreadcrumbAdapterFor(filePath) {
  return ADAPTERS.find((a) => a.supports(filePath)) || null;
}
export const supportsTemplateBreadcrumbs = (filePath) => templateBreadcrumbAdapterFor(filePath) != null;

/** Apply the right adapter for the file. */
export function injectTemplateBreadcrumbs(source, ctx) {
  const adapter = templateBreadcrumbAdapterFor(ctx.filePath);
  if (!adapter) return { ok: false, reason: 'needs-input:template-stack-unsupported', error: `No breadcrumb adapter for ${ctx.filePath}.` };
  return adapter.inject(source, ctx);
}
