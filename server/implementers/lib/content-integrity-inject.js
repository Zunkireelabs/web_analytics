import { resolveFile } from './url-file-map.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';
import { applyExactMatchPatches, describePatchFailure } from './exact-match-patch.js';

// Applies generators/content-integrity-repair.js's fix shapes against
// the real source file. 'malformed-table'/'raw-text-table'/'duplicate-faq'/
// 'font-size-override'/'table-style-drift'/'typography-drift'/
// 'typography-drift-scoped'/'faq-topic-mismatch'/'faq-cross-page-inconsistency'
// all replace one exact HTML (or CSS declaration) anchor (anchorHtml) with
// new text (or empty string, for a removal); 'faq-schema-mismatch' replaces
// the exact raw FAQPage <script> text with corrected JSON, same shape as
// schema-repair-inject.js's 'repair-malformed'. Every branch anchors on the
// EXACT text captured at detection time (page-content.js's static fetch for
// most of them; a real Playwright DOM capture for font-size-override and the
// two design-consistency fixTypes; a fresh re-fetch for
// typography-drift-scoped, since its anchor is CSS text rather than an
// element outerHTML — see font-consistency-capture.js and
// design-agent/live-analysis/capture.js) —
// see exact-match-patch.js for why that's the only safe way to patch
// arbitrary existing template source; a site that changed since detection
// (edited the table, removed the FAQ, re-rendered from different data,
// fixed the style itself) makes the anchor not-found, and this refuses
// rather than guessing at a new location.
//
// Returns an ARRAY of edits (applyExactMatchPatches' own input shape) since
// 'faq-topic-mismatch'/'faq-cross-page-inconsistency' can carry BOTH a
// visible-content edit (anchorHtml/replacement) and an optional FAQPage
// schema resync (schemaOriginalRaw/jsonLd) in the same draft — applied
// together, all-or-nothing, so a page never ends up with corrected visible
// text but a schema that still describes the old, wrong questions.
//
// Exported so implementers/adapters/data-array-content.js's own
// content-integrity-repair branch can reuse the exact same fixType->edits
// mapping instead of a second, driftable copy — the only difference between
// the two implementers is WHERE the anchor is searched for (a whole template
// file here vs. one data-array entry's own byte range there), never how the
// edit itself is derived.
export function buildEdit(content) {
  if (content.fixType === 'malformed-table' || content.fixType === 'raw-text-table'
    || content.fixType === 'duplicate-faq' || content.fixType === 'font-size-override'
    || content.fixType === 'table-style-drift' || content.fixType === 'typography-drift'
    || content.fixType === 'typography-drift-scoped') {
    return [{ anchor: content.anchorHtml, replacement: content.replacement }];
  }
  if (content.fixType === 'faq-schema-mismatch') {
    return [{ anchor: content.originalRaw, replacement: JSON.stringify(content.jsonLd) }];
  }
  if (content.fixType === 'faq-topic-mismatch' || content.fixType === 'faq-cross-page-inconsistency') {
    const edits = [{ anchor: content.anchorHtml, replacement: content.replacement }];
    if (content.schemaOriginalRaw && content.jsonLd) {
      edits.push({ anchor: content.schemaOriginalRaw, replacement: JSON.stringify(content.jsonLd) });
    }
    return edits;
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

  const edits = buildEdit(draft.content || {});
  if (!edits) return { ok: false, reason: 'draft-not-ready', error: `Unknown fix type "${draft.content?.fixType}" on this draft.` };

  const patched = applyExactMatchPatches(file.content, edits);
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
