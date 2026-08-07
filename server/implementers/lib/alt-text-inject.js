import { resolveFile } from './url-file-map.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';
import { applyExactMatchPatches, describePatchFailure } from './exact-match-patch.js';

// Injects a real alt="" attribute into each image generators/alt-text.js
// drafted a caption for, by finding that image's EXACT original <img> tag
// (originalTag, captured verbatim by page-content.js at detection time) in
// the site's real template source and inserting the attribute into it.
// All-or-nothing per draft (see applyExactMatchPatches): if the source has
// drifted since detection and even one tag's anchor no longer matches
// exactly, no image in this draft gets patched — never a partial write a
// human would have to untangle.
function withAlt(originalTag, alt) {
  const escaped = alt.replace(/"/g, '&quot;');
  // Self-closing vs. not doesn't matter for the attribute insertion itself —
  // inserted right after the tag name, before any existing attributes, so
  // it reads naturally regardless of what else the tag already has.
  return originalTag.replace(/^<img\b/i, `<img alt="${escaped}"`);
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
  if (!patched.ok) {
    return { ok: false, reason: 'source-anchor-not-found', error: describePatchFailure(filePath, patched) };
  }
  return { ok: true, filePath, newContent: patched.content, oldContent: file.content };
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
