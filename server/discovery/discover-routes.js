// Resolves the real generated URL for a source file, from the repository's
// own routing evidence (Phase 2, §5) — never from "the directory is called
// blog, so the route must be /blog".
//
// That assumption is wrong often enough to matter: on the validation repo,
// src/pages/about.njk publishes at /about/ (not /pages/about/), and every
// src/blog/*.md publishes via a DIRECTORY DATA FILE's permalink template
// that the post files themselves never mention. A directory-name heuristic
// gets both wrong while looking confident, which is precisely the failure
// mode §5 exists to prevent.
//
// Resolution order mirrors how a static-site generator itself decides, most
// specific first — a page's own front matter beats its directory's default,
// which beats a filename convention.

// Front matter is the leading `---` fenced block. Parsed with a deliberately
// small reader rather than a YAML dependency: the only keys that decide a
// route are scalars (permalink, title, date), and a partial parse that
// silently mis-reads nested YAML would be worse than not reading it.
export function parseFrontMatter(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    // Only top-level `key: value` scalars. Indented lines belong to nested
    // structures this reader intentionally does not interpret.
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (!value) continue;
    value = value.replace(/^["']|["']$/g, '');
    data[kv[1]] = value;
  }
  return data;
}

// Eleventy's `page.fileSlug` is the filename without extension — except for
// index files, where it is the parent directory's name. Implemented from the
// documented behaviour because getting it wrong silently produces a route
// that 404s.
function fileSlug(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  if (stem !== 'index') return stem;
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 2] || 'index';
}

// Substitutes the template expressions that actually appear in permalink
// values. Anything containing an expression this cannot resolve returns null
// — an unresolved template must not be emitted as a literal route.
function renderPermalink(template, sourcePath) {
  if (typeof template !== 'string' || !template) return null;
  const rendered = template
    .replace(/\{\{\s*page\.fileSlug\s*\}\}/g, fileSlug(sourcePath))
    .replace(/\{\{\s*page\.date[^}]*\}\}/g, '');
  if (/\{\{|\{%/.test(rendered)) return null; // still templated → cannot prove
  return rendered;
}

function normalizeRoute(route) {
  if (!route || typeof route !== 'string') return null;
  if (route === 'false') return null; // Eleventy's "do not publish"
  let r = route.startsWith('/') ? route : `/${route}`;
  r = r.replace(/\/{2,}/g, '/');
  return r;
}

// Directory data files (Eleventy's `<dir>/<dir>.json`, e.g.
// src/blog/blog.json) supply defaults — including permalink — to every file
// in that directory. This is the mechanism that makes 22 blog posts share one
// route pattern without any of them declaring it.
export function indexDirectoryDefaults(files, readFileSync) {
  const defaults = new Map();
  for (const path of files) {
    const m = path.match(/^(.*)\/([^/]+)\.json$/);
    if (!m) continue;
    const [, dir, name] = m;
    if (dir.split('/').pop() !== name) continue; // must be <dir>/<dir>.json
    let parsed;
    try { parsed = JSON.parse(readFileSync(path) || ''); } catch { continue; }
    if (parsed && typeof parsed === 'object') defaults.set(dir, { source: path, data: parsed });
  }
  return defaults;
}

// Returns { route, confidence, evidence[] } or null when no route can be
// PROVEN. Returning null is a real outcome, not a failure: §5 forbids
// claiming a route without repository evidence.
export function resolveRoute(sourcePath, { content = null, directoryDefaults = null } = {}) {
  const evidence = [];
  const fm = parseFrontMatter(content);

  // 1. The page's own permalink — the strongest possible evidence, because
  //    it is the generator's own directive for this exact file.
  if (fm?.permalink) {
    const route = normalizeRoute(renderPermalink(fm.permalink, sourcePath));
    if (route) {
      evidence.push({ kind: 'front-matter-permalink', detail: `declares permalink: ${fm.permalink}`, source: sourcePath });
      return { route, confidence: 0.98, evidence, via: 'front-matter' };
    }
  }

  // 2. The directory data file's permalink template, applied to this file.
  const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
  const dirDefault = directoryDefaults?.get(dir);
  if (dirDefault?.data?.permalink) {
    const route = normalizeRoute(renderPermalink(dirDefault.data.permalink, sourcePath));
    if (route) {
      evidence.push({
        kind: 'directory-data-permalink',
        detail: `${dirDefault.source} sets permalink "${dirDefault.data.permalink}" for every file in ${dir}`,
        source: dirDefault.source,
      });
      evidence.push({ kind: 'file-slug', detail: `this file's slug resolves to "${fileSlug(sourcePath)}"`, source: sourcePath });
      return { route, confidence: 0.95, evidence, via: 'directory-data' };
    }
  }

  // No convention-based fallback on purpose. Eleventy's implicit routing
  // depends on input-directory config this module cannot see, so a guess here
  // would be exactly the unevidenced claim §5 prohibits.
  return null;
}

// Resolves routes for a set of page files. `readFile(path) -> string|null` is
// injected so this works against a checked-out tarball (one API call) or a
// test fixture, without this module knowing where bytes come from.
export function discoverRoutes({ files = [], pageFiles = [], readFile = () => null } = {}) {
  const directoryDefaults = indexDirectoryDefaults(files, readFile);

  const routes = [];
  const unresolved = [];
  for (const path of pageFiles) {
    const resolved = resolveRoute(path, { content: readFile(path), directoryDefaults });
    if (resolved) routes.push({ sourceFile: path, ...resolved });
    else unresolved.push({ sourceFile: path, reason: 'no permalink in front matter or directory data — route cannot be proven from the repository' });
  }

  // Group into families so a pattern configured once covers a whole route
  // set, which is what url_file_map's `patterns[]` expresses.
  const byTemplate = new Map();
  for (const r of routes.filter((x) => x.via === 'directory-data')) {
    const dir = r.sourceFile.slice(0, r.sourceFile.lastIndexOf('/'));
    if (!byTemplate.has(dir)) byTemplate.set(dir, []);
    byTemplate.get(dir).push(r);
  }
  const families = [...byTemplate.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([dir, list]) => {
      // The file template only holds if every member shares one extension and
      // its filename is exactly the route's last segment — i.e. the `$1`
      // substitution url_file_map performs would genuinely reproduce each
      // real path. Verified against every member rather than inferred from
      // the first, since one exception makes the whole pattern wrong.
      const extensions = new Set(list.map((l) => l.sourceFile.slice(l.sourceFile.lastIndexOf('.'))));
      const ext = extensions.size === 1 ? [...extensions][0] : null;
      const substitutionHolds = !!ext && list.every((l) => {
        const slug = l.route.replace(/\/$/, '').split('/').pop();
        return l.sourceFile === `${dir}/${slug}${ext}`;
      });

      return {
        directory: dir,
        count: list.length,
        // A regex over the shared prefix — the shape patterns[] expects.
        routePattern: `^${list[0].route.replace(/[^/]+\/?$/, '')}([^/]+)/?$`,
        // null when the substitution does not hold for every member, which
        // leaves the family unprojectable rather than producing a pattern
        // that silently resolves some URLs to files that do not exist.
        templateFile: substitutionHolds ? `${dir}/$1${ext}` : null,
        sampleRoutes: list.slice(0, 3).map((l) => l.route),
        evidence: [
          ...list[0].evidence,
          {
            kind: 'path-substitution-check',
            detail: substitutionHolds
              ? `all ${list.length} files match ${dir}/<slug>${ext}, so $1 substitution reproduces every real path`
              : 'source paths do not follow one <slug>.<ext> shape, so no single file pattern can represent them',
            source: dir,
          },
        ],
        confidence: substitutionHolds ? 0.95 : 0.6,
      };
    });

  return { routes, families, unresolved };
}
