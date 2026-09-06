// Classifies every file in a repository into the roles that matter for safe
// autonomous editing, and groups the page-bearing ones into page types.
//
// The distinction this exists for (Phase 2, §3) is blast radius, not tidiness:
// editing a shared layout changes every page that inherits it, while editing
// one content record changes exactly one page. Those are not the same action
// and must never carry the same risk. Everything here is derived from the repo
// tree — no client-specific rules (§19), no LLM at this layer.
//
// Deliberately NOT a second template system (§4): `templateLanguages` comes
// from detect-technology.js, and the per-file structural work (where content
// can be inserted) stays in implementers/lib/structural-detect.js, which
// already does semantic container detection. This module answers "what is
// this file FOR, and how many pages does it affect" — the question nothing
// currently answers.

// Directory names whose contents are, by near-universal convention across
// generators, shared infrastructure rather than individual pages. Matched as
// a path SEGMENT so `src/_includes/x.njk` hits but `src/blog/includes-me.md`
// does not.
const SHARED_SEGMENTS = new Set([
  '_includes', '_layouts', 'layouts', '_partials', 'partials',
  'components', '_components', 'templates', '_templates', 'macros',
]);

// Data directories: files here are usually the SOURCE for many generated
// pages (an array of records -> a page each), which makes them high-leverage
// and, in the adapter architecture this repo already has, the real edit
// target for data-driven routes.
const DATA_SEGMENTS = new Set(['_data', 'data', '_datasets']);

// Never candidates for content edits, and noisy enough to distort page-type
// grouping if left in.
const IGNORED_SEGMENTS = new Set([
  'node_modules', '.git', '.github', 'dist', 'build', '_site', 'public',
  'coverage', '.cache', 'vendor', '__pycache__', '.claude', '.brain',
]);

const ASSET_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm',
  '.pdf', '.zip', '.map',
]);

const CONFIG_FILENAMES = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json',
  'vercel.json', 'netlify.toml', 'Dockerfile', 'docker-compose.yml',
  'postcss.config.js', 'tailwind.config.js', '.gitignore', '.dockerignore',
]);

function segments(path) { return path.split('/').filter(Boolean); }
function extname(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

// Risk is a property of BLAST RADIUS, and is deliberately decided here rather
// than by whoever later proposes an edit — so the same file cannot be treated
// as low-risk by one code path and high-risk by another. Vocabulary matches
// the existing risk_tier convention ('safe' vs 'manual') used by
// agents/lib/risk-tiers.js, rather than inventing a third scale.
function riskForRole(role, affectedRouteCount) {
  if (role === 'shared-infrastructure' || role === 'build-config') return 'high';
  if (role === 'data-source') return affectedRouteCount > 1 ? 'high' : 'medium';
  if (role === 'page-content') return 'low';
  return 'medium';
}

export function classifyFile(path, { templateExtensions = [] } = {}) {
  const segs = segments(path);
  const ext = extname(path);
  const filename = segs[segs.length - 1] || path;

  if (segs.some((s) => IGNORED_SEGMENTS.has(s))) return { role: 'ignored', reason: 'build output, tooling, or vendored code' };
  if (ASSET_EXTENSIONS.has(ext)) return { role: 'asset', reason: `static asset (${ext})` };
  if (CONFIG_FILENAMES.has(filename)) return { role: 'build-config', reason: 'build/deploy configuration' };
  if (segs.some((s) => SHARED_SEGMENTS.has(s))) {
    const which = segs.find((s) => SHARED_SEGMENTS.has(s));
    return { role: 'shared-infrastructure', reason: `lives in a shared "${which}" directory — inherited by many pages` };
  }
  if (segs.some((s) => DATA_SEGMENTS.has(s))) {
    const which = segs.find((s) => DATA_SEGMENTS.has(s));
    return { role: 'data-source', reason: `lives in a "${which}" directory — typically the source for generated pages` };
  }
  if (templateExtensions.includes(ext)) return { role: 'page-content', reason: `page-bearing template/content file (${ext})` };
  return { role: 'other', reason: 'not recognised as page-bearing, shared, or data' };
}

// Page types are grouped by their containing directory, which is the unit
// generators themselves use (a directory data file, a permalink convention, a
// collection). Grouping by anything finer would produce one "type" per page
// and tell us nothing about shared structure.
function groupIntoPageTypes(pageFiles) {
  const byDir = new Map();
  for (const f of pageFiles) {
    const segs = segments(f.path);
    const dir = segs.slice(0, -1).join('/') || '(root)';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }

  return [...byDir.entries()]
    .map(([dir, group]) => {
      const name = dir === '(root)' ? 'root-pages' : segments(dir).pop();
      return {
        id: dir,
        name,
        directory: dir,
        fileCount: group.length,
        files: group.map((g) => g.path),
        extensions: [...new Set(group.map((g) => extname(g.path)))],
        // A single file in its own directory is a one-off page; many files
        // sharing a directory and extension is a real, repeating page family
        // — the thing worth configuring once and reusing.
        kind: group.length >= 3 ? 'repeating-family' : 'individual-pages',
        risk: 'low',
        evidence: [{
          kind: 'directory-grouping',
          detail: `${group.length} page file(s) share the directory "${dir}"`,
          source: dir,
        }],
      };
    })
    .sort((a, b) => b.fileCount - a.fileCount);
}

// Confidence here is a function of corroboration, matching
// detect-technology.js's rule that independent signals — not a single file,
// and never an LLM's assertion — are what raise it (§9).
function pageTypeConfidence(pageType) {
  if (pageType.fileCount >= 5 && pageType.extensions.length === 1) return { level: 'high', value: 0.95 };
  if (pageType.fileCount >= 3) return { level: 'high', value: 0.85 };
  if (pageType.fileCount === 2) return { level: 'medium', value: 0.65 };
  return { level: 'low', value: 0.4 };
}

// files: repo-relative paths (getRepoTree). templateLanguages: from
// detect-technology.js, so the notion of "a page file" follows the framework
// actually detected rather than a hardcoded extension list.
export function discoverPageStructure({ files = [], templateLanguages = [] } = {}) {
  const templateExtensions = [...new Set(templateLanguages.flatMap((t) => t.extensions || []))];

  const classified = files.map((path) => ({ path, ...classifyFile(path, { templateExtensions }) }));

  const byRole = {};
  for (const c of classified) (byRole[c.role] ||= []).push(c);

  const sharedInfrastructure = (byRole['shared-infrastructure'] || []).map((f) => ({
    path: f.path,
    reason: f.reason,
    // Named explicitly rather than left implicit: this is exactly the set an
    // autonomous agent must not edit without confirmation (§13).
    risk: riskForRole('shared-infrastructure'),
    requiresConfirmation: true,
    evidence: [{ kind: 'path-convention', detail: f.reason, source: f.path }],
  }));

  const dataSources = (byRole['data-source'] || []).map((f) => ({
    path: f.path,
    reason: f.reason,
    risk: riskForRole('data-source', 2),
    requiresConfirmation: false,
    evidence: [{ kind: 'path-convention', detail: f.reason, source: f.path }],
  }));

  const pageTypes = groupIntoPageTypes(byRole['page-content'] || [])
    .map((pt) => ({ ...pt, confidence: pageTypeConfidence(pt) }));

  return {
    pageTypes,
    sharedInfrastructure,
    dataSources,
    buildConfig: (byRole['build-config'] || []).map((f) => f.path),
    counts: Object.fromEntries(Object.entries(byRole).map(([role, list]) => [role, list.length])),
    // Everything the classifier could not place is surfaced, never silently
    // dropped — an unexplained majority here means the heuristics don't fit
    // this repo, which a reader should be able to see.
    unclassified: (byRole.other || []).slice(0, 50).map((f) => f.path),
  };
}

export const __testables = { SHARED_SEGMENTS, DATA_SEGMENTS, riskForRole, pageTypeConfidence };
