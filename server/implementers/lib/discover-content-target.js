import { getRepoTree, getFileContent } from '../../github/client.js';
import { baseBranch } from './github-ops.js';
import { resolveNewContentTarget } from './url-file-map.js';
import { updateSiteRepoConfig } from '../../db.js';
import { recordCapabilityRepair } from '../../store/capability-repairs.js';

// Files where an Eleventy site's own build config can declare a named
// collection — real routing evidence, not a guess, when a site actually
// uses one. Framework convention, not this repo's own invention: these are
// the only file names Eleventy itself will load config from.
const ELEVENTY_CONFIG_FILES = ['.eleventy.js', 'eleventy.config.js', 'eleventy.config.mjs', 'eleventy.config.cjs'];

// Same template-extension set discover-file-mapping.js uses for per-page
// mapping — one convention, not two, for "which files could plausibly be
// authored content."
const CONTENT_EXTENSIONS = ['njk', 'html', 'liquid', 'hbs', 'ejs', 'md', 'jsx', 'tsx', 'astro', 'vue'];

// Directories that hold shared plumbing, never individually-authored
// content, regardless of how many template-extension files they contain —
// the same class of exclusion discover-file-mapping.js's sharedTargetVeto
// applies per-candidate, applied here per-directory instead. A dot-prefixed
// segment is added alongside the underscore convention: no static-site
// generator this app supports ever builds a dotfile/dot-directory into a
// public page — it is universally tooling/config/notes (.git, .github,
// .brain, .vscode, ...) regardless of framework, so excluding it is a
// structural fact, not a framework-specific guess.
const NON_CONTENT_DIR_PATTERN = /(^|\/)[_.]/;

// Below this many files, a directory isn't a real "this is where content
// lives" signal yet — could just as easily be a one-off page that happens to
// share an extension with something else nearby.
const MIN_CONTENT_FILES = 3;

// Corroborating evidence, not the primary signal: when a repo has more than
// one qualifying content directory, a directory whose own path names the
// actionType's content kind is real evidence of WHICH one is meant — the
// spec's own "existing blog directories" language — never used to invent a
// directory that doesn't otherwise qualify on file count. Action types with
// no natural "directory of many" shape (legal pages, translation — each is
// one specific page, not a content family) are deliberately absent: for
// those, only the whole-repo-unique-directory fallback applies.
const DIR_NAME_HINTS = {
  'blog-outline': /(^|\/)(blog|posts?|articles?)(\/|$)/i,
  'direct-answer': /(^|\/)(answers?|faq|qa)(\/|$)/i,
};

function parentDir(file) {
  const idx = file.lastIndexOf('/');
  return idx === -1 ? '' : file.slice(0, idx);
}

function extensionOf(file) {
  const idx = file.lastIndexOf('.');
  return idx === -1 ? null : file.slice(idx); // includes the leading dot, matching resolveNewContentTarget's expected shape
}

// A component/template extension (.njk, .html, .astro, .jsx, .tsx, .vue,
// .liquid, .hbs, .ejs) is unambiguous page-rendering evidence by
// construction — a static-site generator only ever builds these as pages or
// layouts, never as internal notes. Only .md/.mdx are genuinely ambiguous:
// a markdown file can equally be a real, published content page (Eleventy,
// Jekyll, Hugo, Astro content collections all route markdown-with-front-
// matter into public pages) OR a plain internal note with no build
// significance at all (a design doc, an agent's session log, a README-style
// file). This is exactly the real ambiguity behind the 2026-08-27 incident:
// docs/seo-aeo-implementation and .brain/session-logs both qualified on
// file-count alone.
const AMBIGUOUS_CONTENT_EXTENSIONS = new Set(['.md', '.mdx']);

// Real, cross-framework routing evidence: a YAML front-matter block (the
// convention every supported SSG's content pipeline actually keys off —
// Eleventy, Jekyll, Hugo, Astro) containing at least one of the fields that
// makes a page a page rather than prose (a layout to render through, an
// explicit permalink, or a title metadata block a page-listing template
// would need). A plain markdown note (no front matter, or front matter with
// neither) is real evidence AGAINST this directory being site content —
// never fabricated, never assumed from the directory name alone.
const FRONT_MATTER_PAGE_FIELDS = /^(layout|permalink|title)\s*:/m;
function hasPageFrontMatter(content) {
  if (typeof content !== 'string') return false;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  return FRONT_MATTER_PAGE_FIELDS.test(match[1]);
}

// Narrows candidates whose top extension is markdown-shaped (see
// AMBIGUOUS_CONTENT_EXTENSIONS above) to those where a sampled real file
// actually carries page-routing front matter — never touches a candidate
// whose extension is already unambiguous (a .njk/.astro/etc. directory is
// never excluded by this step, since there is nothing genuinely ambiguous
// about it to check). Real repo evidence only: one real file per candidate,
// never a guess from the directory's name or file count alone. A candidate
// this step could not verify (fetch failed, file has no front matter) is
// dropped rather than kept on an unverified assumption — the same
// never-guess discipline discover-file-mapping.js already holds itself to.
async function narrowByRealPageEvidence(site, candidates, repoFiles, { fetchFile, branch }) {
  const out = [];
  for (const candidate of candidates) {
    if (!AMBIGUOUS_CONTENT_EXTENSIONS.has(candidate.extension)) { out.push(candidate); continue; }
    const sample = repoFiles.find((f) => parentDir(f) === candidate.dir && extensionOf(f) === candidate.extension);
    if (!sample) continue; // should not happen (extension count came from this same file list), but never guess if it does
    let file;
    try { file = await fetchFile(site, sample, branch); } catch { continue; } // could not verify — not treated as evidence either way
    if (file?.content && hasPageFrontMatter(file.content)) out.push(candidate);
  }
  return out;
}

// Existing-route evidence: when the site already has a REAL, already-live
// page whose own URL matches the actionType's content-kind convention (e.g.
// an existing /faq/some-question/ page) and whose url_file_map entry points
// at a file inside one of the candidate directories, that is stronger
// evidence than the directory's own name — it's a route the site itself
// already chose and is serving, not an assumption from how a directory
// happens to be named. Drawn from the SAME url_file_map every other
// implementer already treats as this site's one source of truth for real
// routing (see url-file-map.js), so it works identically for every
// framework this app supports, not just Eleventy. Only ever narrows to
// directories with real route evidence; never invents one with none.
function narrowByRoutedUrlEvidence(candidates, actionType, urlFileMap) {
  const hint = DIR_NAME_HINTS[actionType];
  if (!hint) return candidates;
  const routedDirs = new Set();
  for (const [url, entry] of Object.entries(urlFileMap?.pages || {})) {
    if (entry?.file && hint.test(url)) routedDirs.add(parentDir(entry.file));
  }
  for (const pattern of urlFileMap?.patterns || []) {
    if (pattern?.file && pattern.match && hint.test(pattern.match)) routedDirs.add(parentDir(pattern.file));
  }
  if (!routedDirs.size) return candidates;
  const narrowed = candidates.filter((c) => routedDirs.has(c.dir));
  return narrowed.length ? narrowed : candidates;
}

// Framework build-config evidence: an Eleventy site can declare a named
// collection directly in its own build config (`addCollection('faq', ...)`
// built from a real glob) — when that declared name matches the
// actionType's own content-kind convention AND the glob it's built from
// resolves to exactly one candidate directory, the framework itself is
// telling us this directory serves that named kind of content. Real,
// already-shipped configuration, never a guess — and this is Eleventy's own
// documented convention, not anything specific to one client's repo, so it
// applies to any Eleventy site this app onboards. Sites using a different
// framework (no matching config file present) fall straight through
// unchanged — this step is additive evidence, never a requirement.
const COLLECTION_DECL_RE = /addCollection\(\s*['"]([\w-]+)['"][\s\S]{0,400}?getFilteredByGlob\(\s*(\[[^\]]*\]|['"][^'"]*['"])/g;
async function narrowByBuildConfigCollection(site, candidates, actionType, repoFiles, { fetchFile, branch }) {
  const hint = DIR_NAME_HINTS[actionType];
  if (!hint) return candidates;
  const configFile = repoFiles.find((f) => ELEVENTY_CONFIG_FILES.includes(f));
  if (!configFile) return candidates;
  let file;
  try { file = await fetchFile(site, configFile, branch); } catch { return candidates; }
  if (!file?.content) return candidates;

  const matchedDirs = new Set();
  let m;
  COLLECTION_DECL_RE.lastIndex = 0;
  while ((m = COLLECTION_DECL_RE.exec(file.content))) {
    const [, name, globLiteral] = m;
    if (!hint.test(`/${name}/`)) continue;
    for (const glob of [...globLiteral.matchAll(/['"]([^'"]+)['"]/g)].map((g) => g[1])) {
      const dir = glob.split('/*')[0].replace(/^\.\//, '').replace(/\/$/, '');
      if (candidates.some((c) => c.dir === dir)) matchedDirs.add(dir);
    }
  }
  if (!matchedDirs.size) return candidates;
  const narrowed = candidates.filter((c) => matchedDirs.has(c.dir));
  return narrowed.length ? narrowed : candidates;
}

// Groups the repo's real files by directory, and reports every directory
// that has a real, unambiguous claim to being "where new content of this
// kind should go" — never a framework-convention guess. A directory
// qualifies only when MIN_CONTENT_FILES-or-more of its files share one
// predominant extension; the caller must still refuse to pick when more
// than one directory qualifies.
export function findContentDirectories(repoFiles) {
  const byDir = new Map(); // dir -> Map(ext -> count)
  for (const file of repoFiles) {
    const ext = extensionOf(file);
    if (!ext || !CONTENT_EXTENSIONS.includes(ext.slice(1))) continue;
    const dir = parentDir(file);
    if (!dir || NON_CONTENT_DIR_PATTERN.test(`/${dir}/`)) continue;
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    const counts = byDir.get(dir);
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }

  const qualifying = [];
  for (const [dir, counts] of byDir) {
    const [topExt, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount >= MIN_CONTENT_FILES) qualifying.push({ dir, extension: topExt, fileCount: topCount });
  }
  return qualifying;
}

// The Problem-2 counterpart to autoHealFileMapping: a shared, once-per-
// (site, actionType) repair rather than a per-recommendation one, since
// newContentTargets is one config entry that unblocks every recommendation
// of that actionType at once. Never guesses: writes a target only when
// exactly one directory in the whole repo has a clear, real claim to being
// this kind of content's home.
export async function autoHealNewContentTarget(site, actionType, { fetchTree = getRepoTree, fetchFile = getFileContent } = {}) {
  if (!site.repo_owner || !site.repo_name) return null;
  if (resolveNewContentTarget(site, actionType, 'probe')) return null; // already resolvable, nothing to heal

  const branch = baseBranch(site);
  const tree = await fetchTree(site, branch);
  let qualifying = findContentDirectories(tree.files);

  // Real-page-evidence narrowing runs FIRST, before the naming hint below —
  // it is structural/content evidence (does this directory's real content
  // actually look like a routable page, or a plain note), which ranks above
  // a naming convention that could just as easily be coincidental. Only
  // narrows markdown-shaped candidates (see AMBIGUOUS_CONTENT_EXTENSIONS);
  // a single already-unambiguous candidate is never second-guessed by it.
  if (qualifying.length > 1) {
    const narrowed = await narrowByRealPageEvidence(site, qualifying, tree.files, { fetchFile, branch });
    if (narrowed.length) qualifying = narrowed;
  }

  // Existing-route evidence next — a real, already-live URL the site itself
  // serves outranks a directory-name convention, since it's proof of intent
  // rather than an inference from naming. Runs before the build-config and
  // directory-name checks below for the same reason real-page-evidence runs
  // before all of them: stronger evidence first.
  if (qualifying.length > 1) {
    qualifying = narrowByRoutedUrlEvidence(qualifying, actionType, site.url_file_map);
  }

  // Framework build-config evidence: does the site's OWN build config
  // (e.g. an Eleventy addCollection) already declare which directory feeds
  // a named collection matching this actionType's content kind.
  if (qualifying.length > 1) {
    qualifying = await narrowByBuildConfigCollection(site, qualifying, actionType, tree.files, { fetchFile, branch });
  }

  // Narrow by the actionType's own directory-name convention ONLY when there
  // is still more than one real candidate to choose between — a repo with
  // exactly one qualifying content directory already has unambiguous
  // evidence and must not be second-guessed by a naming heuristic that
  // could, in principle, be wrong (e.g. a legitimately-named "src/content"
  // directory). Weakest of the four signals; tried last.
  const hint = DIR_NAME_HINTS[actionType];
  if (qualifying.length > 1 && hint) {
    const narrowed = qualifying.filter((q) => hint.test(`/${q.dir}/`));
    if (narrowed.length) qualifying = narrowed;
  }

  if (qualifying.length !== 1) {
    await recordCapabilityRepair(site.id, {
      capabilityType: 'new-content-target', target: actionType,
      outcome: qualifying.length === 0 ? 'not-found' : 'ambiguous',
      detail: { candidates: qualifying },
    });
    if (qualifying.length > 1) {
      console.warn(`[auto-heal] site #${site.id}: ${qualifying.length} plausible content directories for "${actionType}" (${qualifying.map((q) => q.dir).join(', ')}) — refusing to pick.`);
    }
    return null;
  }

  const { dir, extension } = qualifying[0];
  const cfg = JSON.parse(JSON.stringify(site.url_file_map || {}));
  cfg.newContentTargets = cfg.newContentTargets || {};
  cfg.newContentTargets[actionType] = { dir, extension };

  console.log(`[auto-heal] newContentTargets["${actionType}"]: discovered ${dir} (${extension}) for site #${site.id}, persisting.`);
  await recordCapabilityRepair(site.id, {
    capabilityType: 'new-content-target', target: actionType, outcome: 'repaired',
    evidenceTier: 'directory-scan', detail: { dir, extension, fileCount: qualifying[0].fileCount },
  });
  return updateSiteRepoConfig({ siteId: site.id, urlFileMap: cfg });
}
