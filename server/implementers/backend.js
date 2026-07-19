import { resolveFile, resolveSiteRootFile, resolveMarkers } from './lib/url-file-map.js';
import { pushDraftBranch, mergeBranchToStage, STAGE_BRANCH } from './lib/github-ops.js';
import { getFileContent } from '../github/client.js';
import { buildMergeValues, spliceMarkers } from './lib/marker-merge.js';
import { inspectRenderMode, CONFIDENCE_THRESHOLD } from './lib/render-inspector.js';

export const meta = {
  id: 'backend',
  name: 'Backend/SEO Implementer',
  description: 'Applies machine-readable draft content (schema markup, meta tags, FAQ schema, internal links, llms.txt/robots.txt) as a real pull request.',
  handles: ['schema', 'meta-title', 'faq', 'internal-links', 'llms-txt'],
};

// Every backend.js type with a real merge strategy — see lib/marker-merge.js
// for why (a literal splice between human-placed marker comments, the one
// merge approach that never requires parsing an unknown site's real
// templating syntax). schema is a single self-contained JSON-LD block, same
// shape as faq's; internal-links renders its suggestion list to a
// deterministic <ul> first (see marker-merge.js's renderLinksHtml) — neither
// needs a different mechanism, just its own marker name and value-builder.
const MARKER_MERGE_TYPES = new Set(['meta-title', 'faq', 'schema', 'internal-links']);

// llms-txt is site-level, not per-page — draft.content.llmsTxt/robotsDirectives
// are already full raw file-body strings (server/generators/llms-txt.js), so
// this is a straight file write with zero content transformation needed. The
// only unknown is *where* those files live in this site's repo, which
// site.url_file_map.siteRoot answers explicitly.
async function pushLlmsTxtBranch(site, draft) {
  const llmsPath = resolveSiteRootFile(site, 'llmsTxt');
  if (!llmsPath) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.llmsTxt is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const files = [{ path: llmsPath, content: draft.content.llmsTxt }];

  const robotsPath = resolveSiteRootFile(site, 'robotsTxt');
  if (robotsPath && draft.content.robotsDirectives) {
    files.push({ path: robotsPath, content: draft.content.robotsDirectives });
  }
  return pushDraftBranch(site, draft, files);
}

// Real, marker-based merge for meta-title/faq (see lib/marker-merge.js) —
// shared by preview() (stops here, no GitHub write) and apply() below, so a
// reviewer's preview and the real PR's diff can never diverge; they're
// always the output of this exact same function.
//
// Render mode is no longer static config — it's decided fresh here, every
// call, by inspecting the actual live file (lib/render-inspector.js,
// deterministic-first, LLM only when genuinely ambiguous). `renderModeOverride`
// is the one way a human's already-confirmed choice re-enters this — passed
// through from routes/action-center.js after a prior 'render-mode-uncertain'
// stop, never persisted as site config.
async function computeMarkerMerge(site, draft, renderModeOverride) {
  const page = draft.content?.page || draft.input?.page;
  const filePath = resolveFile(site, page);
  if (!filePath) {
    return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${page || '(no page)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
  }

  const markerMap = resolveMarkers(site, page, draft.action_type);
  if (!markerMap) {
    return {
      ok: false, reason: 'no-insertion-marker',
      error: `No markers configured for "${page}" in url_file_map.pages[...].placements or .markers — add e.g. {"title":"TITLE"} there, and a matching marker in ${filePath}: either <!-- SEOAI:TITLE:START -->...<!-- SEOAI:TITLE:END --> around HTML content, or a trailing # SEOAI:TITLE comment on a single quoted-value line (e.g. front matter).`,
    };
  }

  const branch = STAGE_BRANCH;
  const file = await getFileContent(site, filePath, branch);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${branch}" — confirm the path in url_file_map is correct.` };
  }

  let mode, inspection;
  if (renderModeOverride) {
    mode = renderModeOverride;
  } else {
    inspection = await inspectRenderMode(file.content, draft.action_type);
    if (!inspection.mode || inspection.confidence < CONFIDENCE_THRESHOLD) {
      return {
        ok: false, reason: 'render-mode-uncertain', error: inspection.reason,
        confidence: inspection.confidence, suggestedMode: inspection.mode,
      };
    }
    mode = inspection.mode;
  }

  const built = buildMergeValues(draft.action_type, draft.content, mode);
  if (!built.ok) return { ok: false, reason: 'draft-not-ready', error: built.error };

  const spliced = spliceMarkers(file.content, markerMap, built.values);
  if (!spliced.ok) {
    const names = spliced.missingMarkers.map((m) => `SEOAI:${m}`).join(', ');
    return { ok: false, reason: 'no-insertion-marker', error: `Marker(s) not found in the live file: ${names}. Add them to ${filePath} before this can be applied.` };
  }

  return {
    ok: true, filePath, oldContent: file.content, newContent: spliced.newContent, changedRegions: spliced.changedRegions,
    renderMode: mode, renderModeConfidence: inspection?.confidence ?? null, renderModeReason: inspection?.reason ?? null,
  };
}

// Pushes a real branch (forked from stage) with the real change — not
// merged yet (see mergeToStage below). Staff reviews the real diff (Draft
// Preview panel, unchanged — same computeMarkerMerge output) before
// deciding to merge it into stage. `opts.renderModeOverride` is ignored by
// llms-txt (no mode concept) and simply unused for anything but marker-merge
// types.
export async function apply(site, draft, opts = {}) {
  if (draft.action_type === 'llms-txt') return pushLlmsTxtBranch(site, draft);
  if (MARKER_MERGE_TYPES.has(draft.action_type)) {
    const merged = await computeMarkerMerge(site, draft, opts.renderModeOverride);
    if (!merged.ok) return merged;
    return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }]);
  }
  return { ok: false, reason: 'merge-strategy-not-implemented', error: `No merge strategy for action type "${draft.action_type}".` };
}

// branch_pushed -> merged into stage (real deploy). draft.branch_name is
// already real (persisted by markDraftBranchPushed after apply() above
// succeeded) — this step only merges, no new file writes.
export async function mergeToStage(site, draft) {
  if (!draft.branch_name) return { ok: false, reason: 'no-branch', error: 'No branch has been pushed for this draft yet.' };
  return mergeBranchToStage(site, draft, draft.branch_name);
}

// Zero-write dry run — the real diff a reviewer sees before approving,
// computed by the exact same merge function apply() uses. llms-txt has no
// "merge" step (its draft content already IS the full file body), so its
// preview is just that raw content shown as the "after" — still real, still
// a genuine before/after via a live fetch of the current file.
export async function preview(site, draft, opts = {}) {
  if (draft.action_type === 'llms-txt') {
    const llmsPath = resolveSiteRootFile(site, 'llmsTxt');
    if (!llmsPath) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.llmsTxt is not configured.' };
    const branch = STAGE_BRANCH;
    const file = await getFileContent(site, llmsPath, branch);
    return { ok: true, filePath: llmsPath, oldContent: file?.content || '', newContent: draft.content.llmsTxt };
  }
  if (MARKER_MERGE_TYPES.has(draft.action_type)) return computeMarkerMerge(site, draft, opts.renderModeOverride);
  return { ok: false, reason: 'merge-strategy-not-implemented', error: `No preview available for "${draft.action_type}" yet.` };
}
