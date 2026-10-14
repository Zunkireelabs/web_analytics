// Deterministic route derivation for filesystem-router frameworks — Next.js
// App Router, Next.js Pages Router, and Astro's file-based `src/pages/`.
//
// discover-routes.js's front-matter approach exists because Eleventy's
// directory -> URL mapping is configurable build config (input/output dirs,
// a `permalink:` override) that the repository tree alone cannot prove —
// reading `src/blog/post.md` tells you nothing about its real URL without
// also reading `.eleventy.js` and the file's own front matter.
//
// These three frameworks are different in kind, not just convention: their
// segment -> URL-segment rules (`[slug]`, `[...slug]`, `(group)`, `index`)
// are part of the framework's own fixed specification, identical for every
// app built on it. Reading the file tree under `app/`, `pages/`, or Astro's
// `src/pages/` IS reading the routing table — there is no equivalent to
// Eleventy's configurable `dir.input`. So unlike discover-routes.js, this
// module never needs file content and never falls back to "no convention-
// based guess" — the convention itself is the deterministic, provable
// evidence.
//
// Every family this module proposes still passes through auto-configure.js's
// validateProjection before anything is written: the `sampleRoutes` entry
// here is a synthetic PROBE (not a real observed URL) used purely to prove,
// via the same resolveFile() production code path every real page resolves
// through, that the derived regex and file template are actually consistent
// with each other and reconstruct the exact source file. A pattern that
// fails that round trip is never proposed as resolved.

const APP_ROUTER_ROOTS = ['src/app', 'app'];
const PAGES_ROUTER_ROOTS = ['src/pages', 'pages'];
const ASTRO_PAGES_ROOTS = ['src/pages', 'pages'];

const APP_PAGE_FILE = /^page\.(jsx?|tsx?|mjs)$/;
const PAGES_PAGE_EXT = /\.(jsx?|tsx?|mdx?)$/;
const ASTRO_PAGE_EXT = /\.(astro|md|mdx)$/;
const PAGES_EXCLUDED_BASENAMES = new Set(['_app', '_document', '_error', '_middleware']);

function rootFor(files, roots) {
  return roots.find((root) => files.some((f) => f.startsWith(`${root}/`))) || null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Classifies ONE path segment using Next.js/Astro's shared bracket syntax —
// the single place either framework's special-segment rules are encoded, so
// every branch below reuses this instead of three near-duplicate readings of
// the same spec.
//   (group)        -> route group: contributes NO url segment, kept in the
//                      file path (Next.js App Router).
//   @slot          -> parallel-route slot: not a page's own segment on its
//                      own — refused rather than guessed (see buildRouteShape).
//   _private       -> not routable at all in either framework's convention.
//   [[...name]]    -> optional catch-all: matches zero or more segments.
//   [...name]      -> catch-all: matches one or more segments.
//   [name]         -> single dynamic segment.
//   anything else  -> a literal path segment.
function classifySegment(seg) {
  if (seg.startsWith('(') && seg.endsWith(')')) return { kind: 'group' };
  if (seg.startsWith('@')) return { kind: 'parallel-slot' };
  if (seg.startsWith('_')) return { kind: 'private' };
  const optionalCatchAll = seg.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatchAll) return { kind: 'optional-catch-all', paramName: optionalCatchAll[1] };
  const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return { kind: 'catch-all', paramName: catchAll[1] };
  const dynamic = seg.match(/^\[(.+)\]$/);
  if (dynamic) return { kind: 'dynamic', paramName: dynamic[1] };
  return { kind: 'literal', value: seg };
}

// Builds the shared shape (regex parts, a synthetic probe route, and the
// literal file-path parts) from a page's own directory segments. Returns
// null the moment a parallel-route slot or a private folder appears anywhere
// in the path — both mean this file cannot be represented as one directly-
// resolvable page route, and this refuses rather than silently dropping/
// misreading the segment.
//
// Unlike discover-routes.js's Eleventy families (where `$1` substitutes into
// a REAL per-item file — src/blog/my-post.md genuinely exists as its own
// file), a filesystem router's dynamic segment is served by ONE constant
// file for every matching value (`[slug].tsx` is the file for every slug,
// never renamed per slug) — so fileParts always keeps the segment's real,
// literal text (`[slug]`, `[...slug]`, `(group)`), never a `$N` token. The
// bracket text in the resulting templateFile is exactly what's really on
// disk, which is what makes it verifiable at all.
function buildRouteShape(segments) {
  const urlParts = [];
  const probeParts = [];
  const fileParts = [];
  let paramIndex = 0;

  for (const seg of segments) {
    const c = classifySegment(seg);
    if (c.kind === 'parallel-slot' || c.kind === 'private') return null;
    fileParts.push(seg);
    if (c.kind === 'group') continue;
    if (c.kind === 'literal') {
      urlParts.push(escapeRegExp(c.value));
      probeParts.push(c.value);
      continue;
    }
    paramIndex += 1;
    if (c.kind === 'dynamic') {
      urlParts.push('([^/]+)');
      probeParts.push(`probe-${paramIndex}`);
    } else if (c.kind === 'catch-all') {
      urlParts.push('(.+)');
      probeParts.push(`probe-${paramIndex}a/probe-${paramIndex}b`);
    } else { // optional-catch-all
      urlParts.push('(.*)');
      probeParts.push(`probe-${paramIndex}`);
    }
  }

  return { urlParts, probeParts, fileParts, dynamic: paramIndex > 0, paramCount: paramIndex };
}

function urlPathFrom(parts) {
  return parts.length ? `/${parts.join('/')}` : '/';
}

function routePatternFrom(urlPath) {
  return urlPath === '/' ? '^/$' : `^${urlPath}/?$`;
}

// Next.js App Router: `page.{js,jsx,ts,tsx}` is the only file that defines a
// route; `layout`/`loading`/`error`/`not-found`/`template`/`default`/
// `route`/`middleware` in the same directory wrap or modify it but are never
// themselves a page (Next.js's own file-convention spec) — callers must
// filter to APP_PAGE_FILE, never "any component file under app/".
function discoverAppRouterRoutes(files) {
  const root = rootFor(files, APP_ROUTER_ROOTS);
  if (!root) return { staticRoutes: [], families: [], unresolved: [] };

  const pageFiles = files.filter((f) => f.startsWith(`${root}/`) && APP_PAGE_FILE.test(f.slice(f.lastIndexOf('/') + 1)));

  const staticRoutes = [];
  const families = [];
  const unresolved = [];

  for (const file of pageFiles) {
    const rest = file.slice(root.length + 1);
    const segs = rest.split('/');
    const routeFileName = segs.pop(); // 'page.tsx' — never part of the URL

    const shape = buildRouteShape(segs);
    if (!shape) {
      unresolved.push({ file, reason: 'contains a parallel-route (@slot) or private (_folder) segment — not a directly resolvable page route' });
      continue;
    }

    const urlPath = urlPathFrom(shape.urlParts);
    const probePath = urlPathFrom(shape.probeParts);
    const filePrefix = shape.fileParts.length ? `${root}/${shape.fileParts.join('/')}` : root;
    const templateFile = `${filePrefix}/${routeFileName}`;

    if (!shape.dynamic) {
      staticRoutes.push({
        route: urlPath,
        file,
        evidence: `${file} is a Next.js App Router page.tsx — its directory position is the route ${urlPath}`,
      });
      continue;
    }

    families.push({
      directory: file.slice(0, file.lastIndexOf('/')),
      routePattern: routePatternFrom(urlPath),
      templateFile,
      sampleRoutes: [probePath],
      confidence: 0.97,
      evidence: [{
        kind: 'filesystem-route',
        detail: `Next.js App Router: ${file} defines the route ${urlPath} (${shape.paramCount} dynamic segment(s)) by its directory position — the framework's own routing convention, not an inferred pattern`,
        source: file,
      }],
    });
  }

  return { staticRoutes, families, unresolved };
}

// Shared by Pages Router and Astro: both route by "this file's own path
// (with `index` collapsing into its parent), minus one recognised
// extension" — the only real difference between them is which extensions
// count as a page and which basenames are framework-reserved (Pages
// Router's `_app`/`_document`/`_error`, `api/` never being a page either).
function discoverExtensionBasedRoutes(files, { root, pageExtRegex, excludedBasenames = new Set(), excludeApi = false }) {
  const staticRoutes = [];
  const families = [];
  const unresolved = [];

  const candidates = files.filter((f) => {
    if (!f.startsWith(`${root}/`)) return false;
    const rest = f.slice(root.length + 1);
    if (excludeApi && (rest === 'api' || rest.startsWith('api/'))) return false;
    if (!pageExtRegex.test(rest)) return false;
    return true;
  });

  for (const file of candidates) {
    const rest = file.slice(root.length + 1);
    const lastSlash = rest.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : rest.slice(0, lastSlash);
    const base = lastSlash === -1 ? rest : rest.slice(lastSlash + 1);
    const extMatch = base.match(pageExtRegex);
    const ext = extMatch[0];
    const stem = base.slice(0, base.length - ext.length);

    if (excludedBasenames.has(stem) || stem.startsWith('_')) continue;

    const dirSegs = dir ? dir.split('/') : [];
    // `index` collapses into its own directory — `blog/index.tsx` is the
    // route `/blog`, not `/blog/index` — everywhere else the filename
    // (minus extension) IS the final URL segment.
    const segs = stem === 'index' ? dirSegs : [...dirSegs, stem];

    const shape = buildRouteShape(segs);
    if (!shape) {
      unresolved.push({ file, reason: 'contains a private (_folder/_file) segment — not a directly resolvable page route' });
      continue;
    }

    const urlPath = urlPathFrom(shape.urlParts);
    const probePath = urlPathFrom(shape.probeParts);

    if (!shape.dynamic) {
      staticRoutes.push({ route: urlPath, file, evidence: `${file} resolves to ${urlPath} by its file path` });
      continue;
    }

    // Unlike App Router (where the route file is always the literal
    // `page.tsx` sibling), here the FILENAME itself can be the dynamic
    // segment (`[slug].tsx`) — the last file-path token needs the real
    // extension re-attached, every other token is a plain directory name.
    const fileParts = [...shape.fileParts];
    if (stem !== 'index' || dirSegs.length === 0) {
      fileParts[fileParts.length - 1] = `${fileParts[fileParts.length - 1]}${ext}`;
    } else {
      fileParts.push(`index${ext}`);
    }
    const templateFile = `${root}/${fileParts.join('/')}`;

    families.push({
      directory: dir ? `${root}/${dir}` : root,
      routePattern: routePatternFrom(urlPath),
      templateFile,
      sampleRoutes: [probePath],
      confidence: 0.97,
      evidence: [{
        kind: 'filesystem-route',
        detail: `${file} defines the route ${urlPath} (${shape.paramCount} dynamic segment(s)) by its filename — the framework's own routing convention, not an inferred pattern`,
        source: file,
      }],
    });
  }

  return { staticRoutes, families, unresolved };
}

function discoverPagesRouterRoutes(files) {
  const root = rootFor(files, PAGES_ROUTER_ROOTS);
  if (!root) return { staticRoutes: [], families: [], unresolved: [] };
  return discoverExtensionBasedRoutes(files, {
    root, pageExtRegex: PAGES_PAGE_EXT, excludedBasenames: PAGES_EXCLUDED_BASENAMES, excludeApi: true,
  });
}

function discoverAstroPageRoutes(files) {
  const root = rootFor(files, ASTRO_PAGES_ROOTS);
  if (!root) return { staticRoutes: [], families: [], unresolved: [] };
  return discoverExtensionBasedRoutes(files, { root, pageExtRegex: ASTRO_PAGE_EXT });
}

// frameworkId gates which router convention is even attempted — a `pages/`
// directory alone is not evidence of Next.js (Eleventy's own onboarded sites
// use `src/pages/*.njk` for exactly the front-matter-driven routing
// discover-routes.js already handles), so running this against the wrong
// framework would silently apply the wrong routing spec to files it doesn't
// govern. Next.js repos may use App Router, Pages Router, or both at once
// (an officially supported migration state), so both run whenever the
// framework is Next.js; Astro's file-based pages are a separate branch.
export function discoverFilesystemRoutes({ frameworkId, files = [] }) {
  const empty = { staticRoutes: [], families: [], unresolved: [] };
  const appRouter = frameworkId === 'nextjs' ? discoverAppRouterRoutes(files) : empty;
  const pagesRouter = frameworkId === 'nextjs' ? discoverPagesRouterRoutes(files) : empty;
  const astro = frameworkId === 'astro' ? discoverAstroPageRoutes(files) : empty;

  return {
    staticRoutes: [...appRouter.staticRoutes, ...pagesRouter.staticRoutes, ...astro.staticRoutes],
    families: [...appRouter.families, ...pagesRouter.families, ...astro.families],
    unresolved: [...appRouter.unresolved, ...pagesRouter.unresolved, ...astro.unresolved],
  };
}

export const __testables = { classifySegment, buildRouteShape, discoverAppRouterRoutes, discoverPagesRouterRoutes, discoverAstroPageRoutes };
