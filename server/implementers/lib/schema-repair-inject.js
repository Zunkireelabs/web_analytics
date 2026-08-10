import { resolveFile } from './url-file-map.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';
import { applyExactMatchPatches, describePatchFailure } from './exact-match-patch.js';

// Applies generators/schema-repair.js's two fix shapes against the real
// source file: 'repair-malformed' replaces the broken JSON-LD block's raw
// text with the corrected JSON; 'remove-duplicate' empties out the later
// duplicate block's content (leaving an inert `<script
// type="application/ld+json"></script>` rather than trying to also strip
// the surrounding tag, since only the block's inner text — not its exact
// tag/attributes — was ever captured as the anchor; an empty JSON-LD script
// is silently ignored by every real consumer, so this is a safe, if not
// maximally tidy, fix). Both anchor on the EXACT raw text page-content.js
// captured at detection time — see exact-match-patch.js for why that's the
// only safe way to patch arbitrary existing template source.
function buildEdit(content) {
  if (content.fixType === 'repair-malformed') {
    return { anchor: content.originalRaw, replacement: JSON.stringify(content.jsonLd) };
  }
  if (content.fixType === 'remove-duplicate') {
    return { anchor: content.originalRaw, replacement: '' };
  }
  return null;
}

export async function computeSchemaRepairMerge(site, draft, beforeRef = baseBranch(site)) {
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

export async function pushSchemaRepairBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeSchemaRepairMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

export async function previewLiveSchemaRepair(site, draft) {
  const merged = await computeSchemaRepairMerge(site, draft, baseBranch(site));
  if (!merged.ok) return merged;
  return {
    ok: true,
    filePath: merged.filePath,
    live: true,
    changedRegions: [{ field: draft.content?.fixType || 'schema-repair', before: merged.oldContent, after: merged.newContent }],
  };
}
