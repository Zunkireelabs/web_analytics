import { resolveFile } from './url-file-map.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';
import { applyExactMatchPatches, describePatchFailure } from './exact-match-patch.js';
import { searchRepoLocalForStrings } from './repo-local-search.js';

// Small N — bounds worst-case file-content fetches from the repo-local
// search fallback below, same rationale as backend.js's
// CODE_SEARCH_MAX_CANDIDATES for broken-link-fix's own Layer 2.
const ALT_TEXT_SEARCH_MAX_CANDIDATES = 5;

// Injects a real alt="" attribute into each image generators/alt-text.js
// drafted a caption for, by finding that image's EXACT original <img> tag
// (originalTag, captured verbatim by page-content.js at detection time) in
// the site's real template source and inserting the attribute into it.
// All-or-nothing per draft (see applyExactMatchPatches): if the source has
// drifted since detection and even one tag's anchor no longer matches
// exactly, no image in this draft gets patched — never a partial write a
// human would have to untangle.
export function withAlt(originalTag, alt) {
  const escaped = alt.replace(/"/g, '&quot;');
  // Self-closing vs. not doesn't matter for the attribute insertion itself —
  // inserted right after the tag name, before any existing attributes, so
  // it reads naturally regardless of what else the tag already has. Keeps
  // the tag name's own original casing (<img> vs <IMG>) — a minimal,
  // single-attribute diff, not an incidental normalization of markup this
  // fix has no business touching.
  return originalTag.replace(/^<(img)\b/i, (_m, tagName) => `<${tagName} alt="${escaped}"`);
}

export async function computeAltTextMerge(site, draft, beforeRef = baseBranch(site)) {
  const page = draft.content?.page;
  const filePath = resolveFile(site, page);
  if (!filePath) {
    return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${page || '(no page)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
  }
  const file = await getFileContent(site, filePath, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;

  const items = draft.content?.items || [];
  if (!items.length) return { ok: false, reason: 'draft-not-ready', error: 'This draft has no alt-text items.' };

  const edits = items.map((item) => ({ anchor: item.originalTag, replacement: withAlt(item.originalTag, item.alt) }));
  const patched = applyExactMatchPatches(file.content, edits);
  if (patched.ok) {
    return { ok: true, filePath, newContent: patched.content, oldContent: file.content };
  }

  // Layer 2: the page's own mapped file doesn't contain (all of) these
  // exact <img> tags — real incident, site 1 (2026-09-09 onward): a
  // component-based page's own file can be a thin wrapper with no image
  // markup of its own at all (src/pages/services/data-systems.njk was 440
  // bytes, no <img> anywhere in it), because the hero image actually
  // renders from a shared component the page includes. Every retry hit the
  // identical "anchor no longer found" message for two weeks, worded as if
  // the page's content had changed, when the real problem is that this
  // implementer only ever looked in one file. Same fallback shape as
  // broken-link-fix's own Layer 2 (backend.js/repo-local-search.js): one
  // full-repo scan (cached per site+ref for the run), tried against each
  // real candidate file for the SAME full edit set — a partial match on a
  // wrong file is not evidence, only a file containing every anchor this
  // draft needs is a real candidate.
  let candidates = [];
  try {
    const result = await searchRepoLocalForStrings(site, beforeRef, edits.map((e) => e.anchor), {});
    candidates = result.matches.filter((p) => p !== filePath).slice(0, ALT_TEXT_SEARCH_MAX_CANDIDATES);
  } catch {
    // Missing credential or search outage — fall through to the honest
    // page-file failure below rather than claiming a fallback that never ran.
  }
  for (const candidatePath of candidates) {
    const candidateFile = await getFileContent(site, candidatePath, beforeRef);
    if (!candidateFile || detectConflictMarkers(candidateFile.content)) continue;
    const candidatePatched = applyExactMatchPatches(candidateFile.content, edits);
    if (candidatePatched.ok) {
      return { ok: true, filePath: candidatePath, newContent: candidatePatched.content, oldContent: candidateFile.content };
    }
  }

  return { ok: false, reason: 'source-anchor-not-found', error: describePatchFailure(filePath, patched) };
}

export async function pushAltTextBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeAltTextMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

export async function previewLiveAltText(site, draft) {
  const merged = await computeAltTextMerge(site, draft, baseBranch(site));
  if (!merged.ok) return merged;
  return {
    ok: true,
    filePath: merged.filePath,
    live: true,
    changedRegions: [{ field: 'alt-text', before: merged.oldContent, after: merged.newContent }],
  };
}
