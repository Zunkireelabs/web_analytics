#!/usr/bin/env node
// Sibling-non-leakage half of the Rendering Validation Gate — proves, from
// the REAL BUILT OUTPUT, that a change to one record in a shared,
// data-driven template family (Eleventy pagination and the same shape in
// other static generators — see the zunkiree-analytics app's
// implementers/lib/pagination-routes.js, which this script's front-matter
// parser mirrors) did not leak into sibling pages that share the template.
//
// Installed VERBATIM into a client repo by install-rendering-workflow.js
// (source of truth: this exact file, in the zunkiree-analytics app) and run
// by that repo's own "rendering-validation" workflow (workflow.yml, same
// directory) AFTER the site has been built TWICE — once at the PR's merge
// base, once at its head — into two separate output directories. Compares
// every generated-family URL byte-for-byte between the two builds.
//
// Deliberately zero-dependency (only Node builtins), same discipline as
// check-rendered-output.mjs in this directory: it has to run standalone in
// an arbitrary client repo's CI with no access back to this app's
// node_modules or database. In particular it does NOT read anything from
// the analytics app — no manifest, no provenance file — it discovers
// everything itself from the repo's own real front matter and the two real
// builds, so it stays correct even if a future change to this app's own
// resolver logic drifts from what's committed here.
//
// THE GATE ITSELF: for every discovered pagination route, every sibling
// record's rendered URL must be byte-identical between the base and head
// builds, except for at most ALLOWED_CHANGED_URLS_PER_FAMILY of them. A PR
// that deliberately wants to change an entire family (the family-by-design
// case — see the analytics app's implementers/lib/action-scope.js) must say
// so in its own commit history via FAMILY_WRITE_MARKER, exactly like the
// action-scope.js code comment describes it as a real, human-visible
// per-site content decision, never inferred.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const TEMPLATE_EXTENSIONS = ['njk', 'liquid', 'hbs', 'ejs', 'html', 'md'];
export const ALLOWED_CHANGED_URLS_PER_FAMILY = 1;
// Present anywhere in the PR's commit messages to declare "yes, this family
// is meant to change sitewide" — checked via `git log`, not a file, so it is
// visible in the PR's own history rather than hidden config.
export const FAMILY_WRITE_MARKER = '[family-write]';

// ── Front-matter + route discovery — mirrors pagination-routes.js's
// parsePaginationFrontMatter/discoverPaginationRoutes exactly, duplicated
// here (not imported) because this script has to be self-contained. Any
// change to the real parsing rules there should be mirrored here too.

export function parsePaginationFrontMatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source || '');
  if (!match) return null;
  const fm = match[1];

  const data = /^\s*pagination:[\s\S]*?^\s+data:\s*["']?([\w.-]+)["']?\s*$/m.exec(fm)?.[1];
  if (!data) return null;

  const alias = /^\s+alias:\s*["']?([\w-]+)["']?\s*$/m.exec(fm)?.[1] || null;
  const permalink = /^\s*permalink:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1] || null;

  let routePrefix = null;
  let idField = null;
  if (permalink) {
    const expr = /\{\{\s*([\w]+)\.([\w]+)[^}]*\}\}/.exec(permalink);
    if (expr) {
      idField = expr[2];
      routePrefix = permalink.slice(0, expr.index).replace(/\/+$/, '') || '/';
    }
  }

  return { data, alias, routePrefix, idField };
}

function walkFiles(dir, files = [], relBase = dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkFiles(full, files, relBase);
    else files.push(full);
  }
  return files;
}

function dataFileCandidates(dataName, repoFiles) {
  const suffixes = [`_data/${dataName}.js`, `_data/${dataName}.json`];
  return repoFiles.filter((f) => suffixes.some((s) => f.replaceAll('\\', '/').endsWith(s)));
}

export function discoverPaginationRoutes(repoDir) {
  const files = walkFiles(repoDir).map((f) => f.slice(repoDir.length + 1).replaceAll('\\', '/'));
  const candidates = files.filter((f) => (
    TEMPLATE_EXTENSIONS.some((ext) => f.endsWith(`.${ext}`))
    && !f.includes('/_data/') && !f.includes('/_includes/')
  ));

  const routes = [];
  for (const file of candidates) {
    let source;
    try { source = readFileSync(join(repoDir, file), 'utf8'); } catch { continue; }
    if (!source.includes('pagination:')) continue;

    const fm = parsePaginationFrontMatter(source);
    if (!fm?.routePrefix || !fm.idField || fm.routePrefix === '/' || fm.routePrefix === '') continue;

    const dataFiles = dataFileCandidates(fm.data, files);
    if (dataFiles.length !== 1) continue; // ambiguous/missing data file — nothing safe to enumerate

    routes.push({ template: file, routePrefix: fm.routePrefix, idField: fm.idField, dataFile: dataFiles[0] });
  }
  return routes;
}

// ── Data-file record enumeration — same bounded, no-require/no-network
// sandbox as the analytics app's scripts/lib/safe-js-data-eval.js, because
// Eleventy itself executes these exact files at build time; reading the
// value here is not a new exposure. JSON files are just JSON.parse'd.

function safeEvalJsDataFile(source) {
  if (/\bexport\s+(?!default\s)/.test(source)) return undefined;
  const normalized = source.replace(/export\s+default\s+/, 'module.exports = ');
  const wrapped = `(function () { const module = { exports: {} }; const exports = module.exports; ${normalized} return module.exports; })()`;
  try {
    const context = vm.createContext(Object.create(null));
    const script = new vm.Script(wrapped, { timeout: 1000 });
    return script.runInContext(context, { timeout: 1000 });
  } catch {
    return undefined;
  }
}

export function recordIdsForRoute(repoDir, route) {
  const path = join(repoDir, route.dataFile);
  if (!existsSync(path)) return [];
  const source = readFileSync(path, 'utf8');
  const value = route.dataFile.endsWith('.json')
    ? (() => { try { return JSON.parse(source); } catch { return undefined; } })()
    : safeEvalJsDataFile(source);
  if (!Array.isArray(value)) return [];
  // Built as a fresh loop in THIS (main) realm rather than
  // value.map().filter() — a .js data file is evaluated inside
  // vm.createContext's own separate realm, so calling array methods
  // directly on its result would produce an Array whose prototype belongs
  // to that foreign realm. The array's contents would be identical, but
  // assert.deepStrictEqual (and anything else that checks prototype
  // identity) correctly treats it as a different kind of object — every
  // caller of this function, in this repo or in this app's own tests,
  // expects a plain main-realm array back.
  const ids = [];
  for (const r of value) {
    const id = r?.[route.idField];
    if (typeof id === 'string' || typeof id === 'number') ids.push(String(id));
  }
  return ids;
}

// Eleventy's own convention for a directory-style permalink
// (`/glossary/{{ term.id }}/`): `<outputDir><routePrefix>/<id>/index.html`.
// The same convention every mainstream static generator (Hugo, Jekyll,
// Next.js static export) uses for a "pretty URL" — not guessed, it is what
// the permalink LITERALLY says the URL is, plus the fixed index.html
// filename every one of those tools writes for a directory URL.
function outputPathFor(outputDir, routePrefix, id) {
  return join(outputDir, ...routePrefix.split('/').filter(Boolean), String(id), 'index.html');
}

function readIfExists(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// Content-hashed build asset filenames (Vite's default `[name]-[hash].ext`,
// same convention webpack/Rollup/esbuild all use) are embedded via
// <script src>/<link href> on EVERY page, and the hash is derived from the
// whole bundle — e.g. Tailwind's JIT scan of every template in the repo —
// so it changes on almost any real content edit anywhere in the site, not
// just on the page being linked to. That is a build-tool artifact, not
// page content: normalize it away before the byte comparison so the gate
// isn't tripped sitewide by an unrelated CSS/JS bundle hash on every build.
export function normalizeBuildAssetHashes(html) {
  if (html == null) return html;
  // The hash charset includes '-': Vite (and Rollup) emit base64url-flavoured
  // hashes, so "main-CxmWWX-y.js" is an ordinary filename. Excluding '-' meant
  // exactly those hashes were left un-normalized, and since the CSS hash
  // usually has no dash while the JS one sometimes does, a build could
  // normalize half its assets and still report every page in every family as
  // changed — which is what this function exists to prevent.
  return html.replace(/((?:src|href)=["'])([^"']*?)-[A-Za-z0-9_-]{6,}\.(css|js|mjs)(["'])/g, '$1$2-HASH.$3$4');
}

// The gate itself: for one route, which of its record URLs differ between
// the two real builds. `null` file content (missing on one side) counts as
// changed — a page that appeared or disappeared is exactly the kind of
// leakage this exists to catch, not something to silently skip.
export function compareFamilyBuilds(repoDir, route, baseOutputDir, headOutputDir) {
  const ids = recordIdsForRoute(repoDir, route);
  const changed = [];
  for (const id of ids) {
    const baseContent = normalizeBuildAssetHashes(readIfExists(outputPathFor(baseOutputDir, route.routePrefix, id)));
    const headContent = normalizeBuildAssetHashes(readIfExists(outputPathFor(headOutputDir, route.routePrefix, id)));
    if (baseContent !== headContent) changed.push(`${route.routePrefix}/${id}/`);
  }
  return { routePrefix: route.routePrefix, dataFile: route.dataFile, totalUrls: ids.length, changedUrls: changed };
}

export function commitMessagesInRange(repoDir, baseRef, headRef) {
  try {
    return execFileSync('git', ['log', '--format=%B', `${baseRef}..${headRef}`], { cwd: repoDir, encoding: 'utf8' });
  } catch {
    return ''; // no git history available (e.g. a shallow checkout gone wrong) — fails OPEN on the marker, not on the gate itself
  }
}

// CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , repoDir, baseOutputDir, headOutputDir, baseRef, headRef] = process.argv;
  if (!repoDir || !baseOutputDir || !headOutputDir) {
    console.error('Usage: check-family-siblings.mjs <repoDir> <baseOutputDir> <headOutputDir> [baseRef] [headRef]');
    process.exit(1);
  }

  const routes = discoverPaginationRoutes(repoDir);
  if (!routes.length) {
    console.log('No generated-record route families discovered — nothing to check.');
    process.exit(0);
  }

  const familyWriteDeclared = (baseRef && headRef)
    ? commitMessagesInRange(repoDir, baseRef, headRef).includes(FAMILY_WRITE_MARKER)
    : false;

  const results = routes.map((route) => compareFamilyBuilds(repoDir, route, baseOutputDir, headOutputDir));
  const summary = { checkedAt: new Date().toISOString(), familyWriteDeclared, families: results };
  console.log(JSON.stringify(summary, null, 2));

  const offenders = results.filter((r) => r.changedUrls.length > ALLOWED_CHANGED_URLS_PER_FAMILY);
  if (offenders.length && !familyWriteDeclared) {
    console.error(`\nFAIL — ${offenders.length} route family(ies) changed more than ${ALLOWED_CHANGED_URLS_PER_FAMILY} page(s), and no commit in this PR contains "${FAMILY_WRITE_MARKER}" to declare that intentional:`);
    for (const r of offenders) {
      console.error(`  ${r.routePrefix}/* — ${r.changedUrls.length} of ${r.totalUrls} page(s) changed: ${r.changedUrls.slice(0, 5).join(', ')}${r.changedUrls.length > 5 ? ', …' : ''}`);
    }
    process.exit(1);
  }

  console.log(`\nOK — ${results.length} route family(ies) checked, no unintended leakage into sibling pages.`);
}
