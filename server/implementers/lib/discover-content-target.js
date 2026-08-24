import { getRepoTree } from '../../github/client.js';
import { baseBranch } from './github-ops.js';
import { resolveNewContentTarget } from './url-file-map.js';
import { updateSiteRepoConfig } from '../../db.js';
import { recordCapabilityRepair } from '../../store/capability-repairs.js';

// Same template-extension set discover-file-mapping.js uses for per-page
// mapping — one convention, not two, for "which files could plausibly be
// authored content."
const CONTENT_EXTENSIONS = ['njk', 'html', 'liquid', 'hbs', 'ejs', 'md', 'jsx', 'tsx', 'astro', 'vue'];

// Directories that hold shared plumbing, never individually-authored
// content, regardless of how many template-extension files they contain —
// the same class of exclusion discover-file-mapping.js's sharedTargetVeto
// applies per-candidate, applied here per-directory instead.
const NON_CONTENT_DIR_PATTERN = /(^|\/)_/; // Eleventy/Jekyll convention: an underscore-prefixed segment is never page content

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
export async function autoHealNewContentTarget(site, actionType, { fetchTree = getRepoTree } = {}) {
  if (!site.repo_owner || !site.repo_name) return null;
  if (resolveNewContentTarget(site, actionType, 'probe')) return null; // already resolvable, nothing to heal

  const branch = baseBranch(site);
  const tree = await fetchTree(site, branch);
  let qualifying = findContentDirectories(tree.files);

  // Narrow by the actionType's own directory-name convention ONLY when there
  // is more than one real candidate to choose between — a repo with exactly
  // one qualifying content directory already has unambiguous evidence and
  // must not be second-guessed by a naming heuristic that could, in
  // principle, be wrong (e.g. a legitimately-named "src/content" directory).
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
