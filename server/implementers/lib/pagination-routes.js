import { getRepoTree, getFileContent } from '../../github/client.js';
import { baseBranch } from './github-ops.js';

// Recognises pages that are GENERATED, not authored — one template plus a data
// file producing many URLs (Eleventy pagination, and the same shape in other
// static generators).
//
// This exists because "no url_file_map entry" was the wrong diagnosis for them.
// autoHealFileMapping looks for a real file whose name matches the URL's last
// segment and finds nothing for /glossary/zero-shot-learning/, so the Action
// Center asked someone to add a mapping. There is no file to map: the page is
// produced by src/glossary/glossary-terms.njk from src/_data/glossary.js, and
// pointing the URL at that template would make any fix rewrite every glossary
// page at once. Refusing to guess was right; saying "add a mapping" was not.
//
// Everything below is read from the template's own front matter — the route,
// the data file, the id field, the shared layout. None of it is inferred from
// naming or convention, which is the same evidence bar autoHealFileMapping
// holds itself to.

const TEMPLATE_EXTENSIONS = ['njk', 'liquid', 'hbs', 'ejs', 'html', 'md'];

// Eleventy resolves `pagination.data: glossary` against the _data directory, so
// the file is <dataDir>/<name>.{js,json}. Both are looked for; neither is
// assumed to exist.
function dataFileCandidates(dataName, repoFiles) {
  const suffixes = [`_data/${dataName}.js`, `_data/${dataName}.json`];
  return repoFiles.filter((f) => suffixes.some((s) => f.endsWith(s)));
}

// Minimal front-matter read: enough to recognise the pagination shape, without
// pulling in a YAML parser for four fields. Anything it cannot read confidently
// it reports as absent rather than guessing.
export function parsePaginationFrontMatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source || '');
  if (!match) return null;
  const fm = match[1];

  const data = /^\s*pagination:[\s\S]*?^\s+data:\s*["']?([\w.-]+)["']?\s*$/m.exec(fm)?.[1];
  if (!data) return null; // not a paginating template — the only thing this module cares about

  const alias = /^\s+alias:\s*["']?([\w-]+)["']?\s*$/m.exec(fm)?.[1] || null;
  const layout = /^\s*layout:\s*["']?([\w./-]+)["']?\s*$/m.exec(fm)?.[1] || null;
  const permalink = /^\s*permalink:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1] || null;

  // permalink: /glossary/{{ term.id }}/  ->  prefix '/glossary/', idField 'id'
  let routePrefix = null;
  let idField = null;
  if (permalink) {
    const expr = /\{\{\s*([\w]+)\.([\w]+)[^}]*\}\}/.exec(permalink);
    if (expr) {
      idField = expr[2];
      routePrefix = permalink.slice(0, expr.index).replace(/\/+$/, '') || '/';
    }
  }

  return { data, alias, layout, permalink, routePrefix, idField };
}

// Every paginating template in the repo, with what each one generates.
// One repo-tree read plus one fetch per candidate template; callers should
// cache the result for a whole refresh rather than calling this per page.
export async function discoverPaginationRoutes(site, { fetchTree = getRepoTree, fetchFile = getFileContent } = {}) {
  if (!site?.repo_owner || !site?.repo_name) return [];
  const branch = baseBranch(site);
  const tree = await fetchTree(site, branch);

  // Only source templates, and never the _data or _includes directories —
  // a layout is not a page generator, and neither is the data itself.
  const candidates = tree.files.filter((f) => (
    TEMPLATE_EXTENSIONS.some((ext) => f.endsWith(`.${ext}`))
    && !f.includes('/_data/') && !f.includes('/_includes/') && !f.startsWith('node_modules/')
  ));

  const routes = [];
  for (const file of candidates) {
    let source;
    try { source = (await fetchFile(site, file, branch))?.content; } catch { continue; }
    if (!source || !source.includes('pagination:')) continue;

    const fm = parsePaginationFrontMatter(source);
    if (!fm?.routePrefix || !fm.idField) continue;
    // A permalink of `/{{ item.id }}/` yields a root prefix, which would claim
    // every URL on the site. Real route families live under their own segment;
    // a root-level generator is excluded rather than allowed to match anything.
    if (fm.routePrefix === '/' || fm.routePrefix === '') continue;

    const dataFiles = dataFileCandidates(fm.data, tree.files);
    routes.push({
      template: file,
      routePrefix: fm.routePrefix,
      idField: fm.idField,
      alias: fm.alias,
      dataFile: dataFiles[0] || null,
      dataFileAmbiguous: dataFiles.length > 1,
      layout: fm.layout,
    });
  }
  return routes;
}

// The route that generates this URL, or null. Matched on the permalink's own
// literal prefix, so /glossary/zero-shot-learning/ resolves to the glossary
// route and nothing else claims it.
export function matchPaginationRoute(pageUrl, routes) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl || ''); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return routes.find((r) => r.routePrefix !== '/' && normalized.startsWith(`${r.routePrefix}/`)) || null;
}

// Real head-tag evidence for the two field types whose value is always
// derivable from the generated page's own url/title/description, never
// stored per-item data: `canonical`/`open-graph`. Matched on the tag
// existing at all AND its value being template-interpolated (contains
// `{{`) rather than a literal string — a hardcoded `<link rel="canonical"
// href="https://example.com">` would "match" on presence alone while still
// being wrong on every page, and that's a real, separate site bug this
// generator can't fix through a data-array adapter regardless (there's no
// per-page value to plug in); only interpolated evidence proves the layout
// already produces a genuinely per-page-correct value.
const HEAD_TAG_EVIDENCE = { canonical: /rel=["']canonical["'][^>]*>/i, 'open-graph': /property=["']og:title["'][^>]*>/i };

function tagIsPerPageInterpolated(match) {
  return !!match && /\{\{/.test(match[0]);
}

// Bare `layout:` front-matter reader — deliberately separate from
// parsePaginationFrontMatter above, which only returns non-null for a
// PAGINATING template (`pagination: data: ...` present); a plain layout
// file (base.njk, comparison.njk) has no pagination block of its own but
// still needs its own `layout:` chain followed.
function extractLayoutField(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source || '');
  if (!match) return null;
  return /^\s*layout:\s*["']?([\w./-]+)["']?\s*$/m.exec(match[1])?.[1] || null;
}

// Locates a layout-file by its bare name (as it appears in front matter —
// `layout: base.njk`, never a full path) against the real repo tree.
// Refuses (returns null) on zero or more-than-one match rather than
// guessing which one a bare name meant — same evidence bar as
// discoverPaginationRoutes' own dataFileCandidates.
async function findLayoutFile(name, tree, fetchFile, site, branch) {
  const matches = tree.files.filter((f) => f === name || f.endsWith(`/${name}`));
  if (matches.length !== 1) return null;
  try {
    const file = await fetchFile(site, matches[0], branch);
    return file ? { path: matches[0], content: file.content } : null;
  } catch { return null; }
}

// Whether a pagination-generated route's OWN shared layout chain (its
// `layout:` front matter, followed up to a bounded number of hops the same
// way Eleventy itself resolves `layout: x` -> x's own `layout: y` -> ...)
// already renders this head tag with a real per-page value — in which case
// a canonical/open-graph recommendation for one of this route's pages can
// never be satisfied by any per-item data write (there's nothing to write;
// the layout already computes it) and should be dropped, not left blocked
// forever asking someone to "configure a data-array-content adapter" for a
// field with no per-item concept. Only checked for canonical/open-graph —
// see HEAD_TAG_EVIDENCE; every other action type keeps going through
// paginationBlockedReason as before. Direct file evidence only, same
// "checked, not guessed" discipline as the rest of this module: a repo read
// failure or an ambiguous/missing layout file honestly returns false
// (stays blocked) rather than assuming either way.
export async function paginationHeadTagAutoHandled(site, route, actionType, { fetchFile = getFileContent, fetchTree = getRepoTree, branch } = {}) {
  const pattern = HEAD_TAG_EVIDENCE[actionType];
  if (!pattern || !route.layout || !site?.repo_owner || !site?.repo_name) return false;
  const resolvedBranch = branch || baseBranch(site);
  let tree;
  try { tree = await fetchTree(site, resolvedBranch); } catch { return false; }

  let layoutName = route.layout;
  const seen = new Set();
  for (let hop = 0; hop < 4 && layoutName && !seen.has(layoutName); hop++) {
    seen.add(layoutName);
    const found = await findLayoutFile(layoutName, tree, fetchFile, site, resolvedBranch);
    if (!found) return false;
    if (tagIsPerPageInterpolated(pattern.exec(found.content))) return true;
    layoutName = extractLayoutField(found.content);
  }
  return false;
}

// What a human actually needs to know when a generated page cannot be fixed
// yet. Names the real mechanism — which template, which data file — instead of
// asking for a file mapping that would be wrong even if someone added it.
export function paginationBlockedReason(route, actionType) {
  const where = route.dataFile
    ? `its entry in ${route.dataFile} (matched by "${route.idField}")`
    : `its source data (the ${route.alias || 'item'} data behind ${route.template})`;
  return `${route.routePrefix}/* pages are generated by ${route.template}, one per item, so there is no per-page file to map — pointing this URL at that template would make any fix rewrite every page in the family at once. A "${actionType}" fix for this page belongs in ${where}, or in the shared layout${route.layout ? ` (${route.layout})` : ''} if it should apply to all of them. Configure a data-array-content adapter for this route, or fix it by hand.`;
}
