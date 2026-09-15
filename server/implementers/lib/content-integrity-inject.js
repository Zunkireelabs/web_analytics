import { resolveFile } from './url-file-map.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';
import { applyExactMatchPatches, describePatchFailure } from './exact-match-patch.js';

// Applies generators/content-integrity-repair.js's seven fix shapes against
// the real source file. 'malformed-table'/'raw-text-table'/'duplicate-faq'/
// 'font-size-override'/'table-style-drift'/'typography-drift' all replace
// one exact HTML anchor (anchorHtml) with new markup (or empty string, for a
// removal); 'faq-schema-mismatch' replaces the exact raw FAQPage <script>
// text with corrected JSON, same shape as schema-repair-inject.js's
// 'repair-malformed'. Every branch anchors on the EXACT text captured at
// detection time (page-content.js's static fetch for the first two and
// faq-schema-mismatch/duplicate-faq; a real Playwright DOM capture for
// font-size-override and the two design-consistency fixTypes — see
// font-consistency-capture.js and design-agent/live-analysis/capture.js) —
// see exact-match-patch.js for why that's the only safe way to patch
// arbitrary existing template source; a site that changed since detection
// (edited the table, removed the FAQ, re-rendered from different data,
// fixed the style itself) makes the anchor not-found, and this refuses
// rather than guessing at a new location.
// Exported so implementers/adapters/data-array-content.js's own
// content-integrity-repair branch can reuse the exact same fixType->
// {anchor,replacement} mapping instead of a second, driftable copy — the
// only difference between the two implementers is WHERE the anchor is
// searched for (a whole template file here vs. one data-array entry's own
// byte range there), never how the edit itself is derived.
export function buildEdit(content) {
  if (content.fixType === 'malformed-table' || content.fixType === 'raw-text-table'
    || content.fixType === 'duplicate-faq' || content.fixType === 'font-size-override'
    || content.fixType === 'table-style-drift' || content.fixType === 'typography-drift') {
    return { anchor: content.anchorHtml, replacement: content.replacement };
  }
  if (content.fixType === 'faq-schema-mismatch') {
    return { anchor: content.originalRaw, replacement: JSON.stringify(content.jsonLd) };
  }
  return null;
}

export async function computeContentIntegrityMerge(site, draft, beforeRef = baseBranch(site)) {
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

  const edit = buildEdit(draft.content || {});
  if (!edit) return { ok: false, reason: 'draft-not-ready', error: `Unknown fix type "${draft.content?.fixType}" on this draft.` };

  const patched = applyExactMatchPatches(file.content, [edit]);
  if (!patched.ok) {
    return { ok: false, reason: 'source-anchor-not-found', error: describePatchFailure(filePath, patched) };
  }
  return { ok: true, filePath, newContent: patched.content, oldContent: file.content };
}

export async function pushContentIntegrityBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeContentIntegrityMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

export async function previewLiveContentIntegrity(site, draft) {
  const merged = await computeContentIntegrityMerge(site, draft, baseBranch(site));
  if (!merged.ok) return merged;
  return {
    ok: true,
    filePath: merged.filePath,
    live: true,
    changedRegions: [{ field: draft.content?.fixType || 'content-integrity-repair', before: merged.oldContent, after: merged.newContent }],
  };
}
