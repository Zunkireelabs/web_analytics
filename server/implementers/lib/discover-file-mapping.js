import { getRepoTree, getFileContent, searchCodeForString } from '../../github/client.js';
import { baseBranch } from './github-ops.js';
import { resolveFile, resolveAdapter, resolveHostScope } from './url-file-map.js';
import { updateSiteRepoConfig } from '../../db.js';
import { matchPaginationRoute, parsePaginationFrontMatter } from './pagination-routes.js';
import { ownDomains, hostnameOf } from '../../agents/lib/site-domain.js';
import { recordCapabilityRepair } from '../../store/capability-repairs.js';

// Action-type-agnostic file discovery, extracted from
// server/scripts/discover-url-file-map.js so it has exactly one
// implementation instead of two independently-maintained copies — that
// script's own faq-specific data-loop verification stays there (it's real
// adapter-routing logic, not file discovery), but "find the one real file in
// the repo whose name matches this URL" is generic and now shared by both
// the manual CLI and autoHealFileMapping below.

// jsx/tsx/astro/vue added alongside the original template-engine extensions
// now that structural-detect.js + insertion-engine.js give this app a real,
// non-guessing way to find (and create) a safe insertion point on those
// component-based formats too — before that existed, auto-mapping a page to
// one of these files would have been a dead end anyway (no safe way to ever
// splice content into it), so they were deliberately left out.
const TEMPLATE_EXTENSIONS = ['njk', 'html', 'liquid', 'hbs', 'ejs', 'md', 'jsx', 'tsx', 'astro', 'vue'];

export function normalizedPath(pageUrl) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

// Finds a single, real candidate file by matching the URL's last path
// segment against real filenames in the repo's own tree — never a
// framework-convention guess. Multiple matches are disambiguated using the
// URL's other segments as directory hints; anything still ambiguous is
// reported, not picked for.
export function findCandidateFile(pageUrl, repoFiles) {
  const segments = normalizedPath(pageUrl).split('/').filter(Boolean);
  if (!segments.length) return { kind: 'ambiguous', candidates: [] };
  const lastSegment = segments[segments.length - 1];

  const extPattern = new RegExp(`/${lastSegment}\\.(${TEMPLATE_EXTENSIONS.join('|')})$`);
  let candidates = repoFiles.filter((f) => extPattern.test(`/${f}`));

  if (candidates.length > 1 && segments.length > 1) {
    const otherSegments = segments.slice(0, -1);
    const narrowed = candidates.filter((f) => otherSegments.every((seg) => f.includes(seg)));
    if (narrowed.length) candidates = narrowed;
  }

  if (candidates.length === 1) return { kind: 'resolved', file: candidates[0] };
  return { kind: 'ambiguous', candidates };
}

// Reuses an ALREADY-TRUSTED mapping as a pattern, rather than re-deriving one
// from scratch: if a sibling URL under the same parent directory is already
// mapped to a real file whose name literally contains that sibling's own
// slug, substituting THIS url's slug into that same file path is real
// evidence — not a framework-convention guess — because the resulting path
// is only trusted if it is an ACTUAL file in the repo tree. Two siblings that
// derive to two different real files disagree with each other and neither
// is trusted; only unanimous agreement (however many siblings support it)
// counts. No siblings, or no sibling whose file contains its own slug,
// simply falls through with 'ambiguous' — this tier is purely additive.
export function findCandidateFileBySiblingPattern(site, pageUrl, repoFiles) {
  const segments = normalizedPath(pageUrl).split('/').filter(Boolean);
  if (!segments.length) return { kind: 'ambiguous', candidates: [] };
  const slug = segments[segments.length - 1];
  const parentPath = `/${segments.slice(0, -1).join('/')}`;
  const targetPath = normalizedPath(pageUrl);

  // Siblings are drawn from pageUrl's OWN hostname scope (see url-file-map.js's
  // resolveHostScope) — a sibling on a different hostname is not evidence
  // for this one, even if it shares the same path shape.
  const { pages: scopedPages } = resolveHostScope(site, pageUrl);
  const siblings = Object.entries(scopedPages || {})
    .filter(([url, entry]) => typeof entry?.file === 'string')
    .map(([url, entry]) => ({ url: normalizedPath(url), file: entry.file }))
    .filter((s) => s.url !== targetPath && s.url.startsWith(`${parentPath === '/' ? '' : parentPath}/`));

  const derived = new Set();
  for (const sib of siblings) {
    const sibSlug = sib.url.split('/').filter(Boolean).pop();
    if (!sibSlug || !sib.file.includes(sibSlug)) continue; // this sibling's own file doesn't literally carry its slug — no derivable pattern
    const candidate = sib.file.split(sibSlug).join(slug);
    if (repoFiles.includes(candidate)) derived.add(candidate);
  }
  if (derived.size === 1) return { kind: 'resolved', file: [...derived][0] };
  return { kind: 'ambiguous', candidates: [...derived] };
}

// The directory-index convention findCandidateFile cannot see: a directory
// named after the URL's own last segment, containing a file literally named
// `index.<ext>` — e.g. /compare/ served by src/compare/index.njk, not by any
// file named "compare.njk". findCandidateFile only ever looks for a file
// whose OWN name matches the URL segment; it has no notion of "or a same-named
// directory's index file", so this pattern always fell through to ambiguous
// no matter how unambiguous the repo evidence actually was. Root (`/`) has no
// last segment to look for a directory of, so it is deliberately out of scope
// here — see findCandidateFileByPermalink below for that case instead.
export function findCandidateFileByDirectoryIndex(pageUrl, repoFiles) {
  const segments = normalizedPath(pageUrl).split('/').filter(Boolean);
  if (!segments.length) return { kind: 'ambiguous', candidates: [] };
  const lastSegment = segments[segments.length - 1];

  const indexPattern = new RegExp(`(^|/)${lastSegment}/index\\.(${TEMPLATE_EXTENSIONS.join('|')})$`);
  let candidates = repoFiles.filter((f) => indexPattern.test(f));

  if (candidates.length > 1 && segments.length > 1) {
    const otherSegments = segments.slice(0, -1);
    const narrowed = candidates.filter((f) => otherSegments.every((seg) => f.includes(seg)));
    if (narrowed.length) candidates = narrowed;
  }

  if (candidates.length === 1) return { kind: 'resolved', file: candidates[0] };
  return { kind: 'ambiguous', candidates };
}

// Builds a permalink -> [files] index by reading every template file's real
// front matter once — the only way to discover a page whose URL isn't
// derivable from its filename or directory at all (the site root chief among
// them: `/` has no path segment for any of the tree-only tiers above to key
// on). This is the moderate-cost tier: real evidence (a literal `permalink:`
// declaration is as authoritative as a route gets — the framework itself
// reads the same field to decide where the page renders), but one Contents
// API fetch per template file, so callers resolving many pages in one pass
// should build this ONCE and pass it through via `permalinkIndex` rather
// than letting every call rebuild it — the same sharing discipline `tree`
// already gets via `fetchTree`.
export async function buildPermalinkIndex(site, tree, { fetchFile = getFileContent, branch } = {}) {
  const templateFiles = tree.files.filter((f) => TEMPLATE_EXTENSIONS.some((ext) => f.endsWith(`.${ext}`)));
  const index = new Map(); // permalink -> [files]
  await Promise.all(templateFiles.map(async (file) => {
    let content;
    try { content = (await fetchFile(site, file, branch))?.content; } catch { content = null; }
    if (!content) return;
    // A pagination template's permalink is itself a template expression
    // (`/locations/{{ location.id }}/`), never a literal path — matched here
    // only to explicitly EXCLUDE it from the index, so a dynamic template is
    // never mistaken for a static page's own file just because it happens to
    // have a `permalink:` line at all.
    const m = content.match(/^permalink:\s*(.+)$/m);
    if (!m) return;
    const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (/[{}]/.test(raw)) return; // template expression, not a literal path — see above
    // normalizedPath's trailing-slash-stripping applies just as correctly to
    // a bare frontmatter path as to a full URL (its try/catch already falls
    // back to treating a non-URL string as the path itself) — reused here so
    // "/compare/" (as written in front matter) and "/compare" (a lookup key
    // built from a full URL) are the same key, not two that silently never match.
    const literal = normalizedPath(raw);
    if (!index.has(literal)) index.set(literal, []);
    index.get(literal).push(file);
  }));
  return index;
}

// Pure lookup against an already-built index — never fetches anything
// itself, so it stays cheap to call per-URL once the index exists.
export function findCandidateFileByPermalink(pageUrl, permalinkIndex) {
  const path = normalizedPath(pageUrl);
  const files = permalinkIndex.get(path) || [];
  if (files.length === 1) return { kind: 'resolved', file: files[0] };
  return { kind: 'ambiguous', candidates: files };
}

// Last-resort evidence tier, only reached when neither the sibling pattern
// nor the plain filename match found a single candidate: GitHub code search
// for the URL's own path literally appearing in the repo (a real
// `permalink:`/`slug:`/`url:` front-matter declaration, or a route
// registration, not a filename coincidence). Deliberately reached LAST — see
// github/client.js's searchCodeForString doc comment: it only indexes the
// default branch, has a stricter rate limit, and throws outright on a
// fine-grained PAT, so this must never be the first thing tried for every
// unmapped page. A thrown/unavailable search is treated the same as "found
// nothing" — it must never be read as evidence of absence.
export async function findCandidateFileByCodeSearch(site, pageUrl, { searchCode = searchCodeForString } = {}) {
  const path = normalizedPath(pageUrl);
  if (!path || path === '/') return { kind: 'ambiguous', candidates: [] };
  let paths;
  try {
    paths = await searchCode(site, path);
  } catch {
    return { kind: 'ambiguous', candidates: [] }; // search unavailable/rate-limited — not evidence either way
  }
  const candidates = (paths || []).filter((f) => TEMPLATE_EXTENSIONS.some((ext) => f.endsWith(`.${ext}`)));
  if (candidates.length === 1) return { kind: 'resolved', file: candidates[0] };
  return { kind: 'ambiguous', candidates };
}

// Refuses a candidate file findCandidateFile matched, when the evidence says
// it is a SHARED target rather than this one page's own file. A coincidental
// last-segment match ("URL -> FILE") is not enough evidence on its own — the
// candidate itself has to be checked for whether writing into it would
// change more than the intended page.
//
// Four checks, cheapest/most-certain first. Each one is real repo evidence,
// never a naming convention:
//   1. `routes` (this site's discovered pagination families, if the caller
//      has them) says this exact URL is generated by a shared template —
//      the strongest and cheapest signal, since it needs no extra fetch.
//   2. the candidate FILE ITSELF carries `pagination:` front matter — catches
//      a shared generator even when the caller has no discovered routes to
//      check against (e.g. a first heal attempt before any route scan ran).
//   3. the candidate lives under `_includes`/`_layouts` — a layout is
//      rendered by every page that uses it, by definition, whether or not it
//      happens to carry pagination front matter itself.
//   4. the candidate is already mapped to a DIFFERENT url in `cfg.pages` —
//      direct proof of sharing: the same file is already recorded as
//      authoritative for another URL.
async function sharedTargetVeto(site, pageUrl, candidateFile, { routes, fetchFile = getFileContent, branch }) {
  if (routes && matchPaginationRoute(pageUrl, routes)) {
    return `${pageUrl} is inside a known generated-route family; mapping it to a file would be a page-specific action on a shared target.`;
  }
  if (/\/(_includes|_layouts)\//.test(`/${candidateFile}`)) {
    return `${candidateFile} is a shared layout/include, not a per-page file.`;
  }
  const existingForOtherUrl = Object.entries(resolveHostScope(site, pageUrl).pages || {})
    .find(([url, entry]) => entry?.file === candidateFile && normalizedPath(url) !== normalizedPath(pageUrl));
  if (existingForOtherUrl) {
    return `${candidateFile} is already mapped to ${existingForOtherUrl[0]} — mapping a second URL to the same file would make a page-specific fix apply to both.`;
  }
  // Cheapest checks first; only fetch the candidate's own content if nothing
  // above already refused it.
  let source;
  try { source = (await fetchFile(site, candidateFile, branch))?.content; } catch { source = null; }
  if (source && parsePaginationFrontMatter(source)) {
    return `${candidateFile} itself carries pagination front matter — it generates many pages, not one.`;
  }
  return null;
}

// The self-healing counterpart to discover-url-file-map.js's manual CLI:
// called inline the first time a push actually needs a page's file path
// instead of waiting for someone to remember to run the script and re-apply
// its output. Same evidence bar as the CLI (exactly one real filename
// match, or nothing is written) — never guesses, never partially trusted.
// Returns the resolved site (with url_file_map updated) on success, or null
// if nothing could be safely resolved OR the only candidate was refused by
// sharedTargetVeto above.
//
// `fetchTree` is injectable so a caller resolving MANY pages in one pass can
// share a single repo-tree read across all of them — getRepoTree costs two
// GitHub calls (branch sha, then the recursive tree) and the tree is identical
// for every page on the same branch. buildRecommendations does exactly this;
// without it, healing a tenant's whole unmapped page set would issue two
// GitHub calls per page. Defaults to the real getRepoTree so existing callers
// are unaffected.
//
// `routes` (this site's discovered pagination families) is optional and
// purely an optimization for the veto above — omitting it does not weaken
// safety, since sharedTargetVeto's other three checks (front matter,
// _includes/_layouts, already-mapped-elsewhere) apply regardless. A caller
// resolving many pages should pass the same discoverPaginationRoutes result
// it is already caching for its own gates, so this never re-discovers routes
// once per page.
export async function autoHealFileMapping(site, pageUrl, actionType, {
  fetchTree = getRepoTree, fetchFile = getFileContent, searchCode = searchCodeForString, routes, permalinkIndex,
} = {}) {
  if (!site.repo_owner || !site.repo_name) return null;
  if (resolveFile(site, pageUrl)) return null; // already resolvable, nothing to heal
  if (resolveAdapter(site, pageUrl, actionType)) return null; // adapter-routed pages are a separate concern, not a missing file mapping

  // Never attempt to resolve a URL this site does not even claim as its own.
  // ownDomains(site) returns null (pass-through) only when website_domain
  // itself was never set — an unconfigured site has no repair to attempt
  // anyway (the repo_owner/repo_name check above already returned). When it
  // IS set, a foreign hostname must never reach the repo-search evidence
  // below: mapping another property's URL onto this site's repo would be a
  // wrong mapping by construction, not a merely low-confidence one.
  const domains = ownDomains(site);
  const host = hostnameOf(pageUrl);
  if (domains && (!host || !domains.includes(host))) {
    console.warn(`[auto-heal] site #${site.id}: ${pageUrl} is not on a registered own-domain (${domains.join(', ')}) — refusing to attempt a repair.`);
    await recordCapabilityRepair(site.id, {
      capabilityType: 'url-file-map-page', target: pageUrl, outcome: 'foreign-domain',
      detail: { hostname: host, ownDomains: domains },
    });
    return null;
  }

  // A REGISTERED but non-primary hostname (e.g. edgex.zunkireelabs.com when
  // website_domain is zunkireelabs.com) is not a foreign domain — but the
  // evidence tiers below cannot safely resolve it either. Every one of them
  // reasons about ONE shared repo's routes (a filename, a directory, a
  // literal `permalink:` declaration) with no way to know which of the
  // site's several real hostnames that route is actually served on — a
  // `permalink: /` match proves a file serves ITS hostname's root, never
  // which hostname that is on a multi-domain site. Real incident: this
  // exact ambiguity is what produced the false edgex.zunkireelabs.com/ ->
  // src/pages/index.njk mapping this guard now prevents (see
  // resolveHostScope's own doc comment in url-file-map.js). A non-primary
  // hostname's pages resolve ONLY from an explicit
  // url_file_map.hosts[hostname] entry — never auto-discovered.
  const scope = resolveHostScope(site, pageUrl);
  if (scope.scope === 'host') {
    console.warn(`[auto-heal] site #${site.id}: ${pageUrl} is on a registered non-primary hostname (${scope.host}) — auto-discovery is not safe across hostnames on a shared repo; refusing. Add an explicit url_file_map.hosts["${scope.host}"] entry instead.`);
    await recordCapabilityRepair(site.id, {
      capabilityType: 'url-file-map-page', target: pageUrl, outcome: 'requires-explicit-host-config',
      detail: { hostname: scope.host },
    });
    return null;
  }

  const branch = baseBranch(site);
  const tree = await fetchTree(site, branch);

  // Evidence tiers, cheapest/most-certain first, expensive/rate-limited
  // last. Each is tried in isolation — a tier that returns >1 candidate is
  // ambiguous on its OWN evidence and the next tier gets a fresh attempt,
  // never a merge across tiers. The first tier to resolve to exactly one
  // (still-unvetoed) candidate wins.
  //
  // sibling-pattern / filename-match / directory-index are all pure reads of
  // the already-fetched tree — free once `tree` exists. permalink-frontmatter
  // is the one moderate-cost tier (one Contents fetch per template file,
  // amortized across a whole pass via the injectable `permalinkIndex`) —
  // still ordered before permalink-search because it is real, literal
  // evidence (the framework's own routing field), not a last-resort proxy
  // for it.
  const tiers = [
    ['sibling-pattern', () => findCandidateFileBySiblingPattern(site, pageUrl, tree.files)],
    ['filename-match', () => findCandidateFile(pageUrl, tree.files)],
    ['directory-index', () => findCandidateFileByDirectoryIndex(pageUrl, tree.files)],
    ['permalink-frontmatter', async () => {
      // permalinkIndex may be a pre-built Map, a (lazy) function returning
      // one, or omitted — only actually building it (one Contents fetch per
      // template file) if this tier is reached at all. A caller resolving
      // many pages in one pass should pass a memoizing function so the FIRST
      // page that needs this tier pays the cost and every later one reuses
      // the result — see recommendation-gates.js's cachedPermalinkIndex.
      const index = typeof permalinkIndex === 'function'
        ? await permalinkIndex()
        : permalinkIndex || await buildPermalinkIndex(site, tree, { fetchFile, branch });
      return findCandidateFileByPermalink(pageUrl, index);
    }],
    ['permalink-search', () => findCandidateFileByCodeSearch(site, pageUrl, { searchCode })],
  ];

  let resolvedFile = null;
  let resolvedTier = null;
  const attempted = [];
  for (const [tier, run] of tiers) {
    const result = await run();
    attempted.push({ tier, ...result });
    if (result.kind !== 'resolved') continue;
    const refusal = await sharedTargetVeto(site, pageUrl, result.file, { routes, fetchFile, branch });
    if (refusal) {
      console.warn(`[auto-heal] site #${site.id}: refusing to map ${pageUrl} -> ${result.file} (${tier}): ${refusal}`);
      attempted[attempted.length - 1] = { tier, kind: 'refused', file: result.file, reason: refusal };
      continue;
    }
    resolvedFile = result.file;
    resolvedTier = tier;
    break;
  }

  if (!resolvedFile) {
    await recordCapabilityRepair(site.id, {
      capabilityType: 'url-file-map-page', target: pageUrl, outcome: 'ambiguous', detail: { attempted },
    });
    return null;
  }

  const path = normalizedPath(pageUrl);
  const cfg = JSON.parse(JSON.stringify(site.url_file_map || {}));
  cfg.pages = cfg.pages || {};
  cfg.pages[path] = { ...(cfg.pages[path] || {}), file: resolvedFile };

  console.log(`[auto-heal] url_file_map: discovered "${path}" -> ${resolvedFile} for site #${site.id} (${resolvedTier}), persisting.`);
  await recordCapabilityRepair(site.id, {
    capabilityType: 'url-file-map-page', target: pageUrl, outcome: 'repaired',
    evidenceTier: resolvedTier, detail: { file: resolvedFile, attempted },
  });
  return updateSiteRepoConfig({ siteId: site.id, urlFileMap: cfg });
}
