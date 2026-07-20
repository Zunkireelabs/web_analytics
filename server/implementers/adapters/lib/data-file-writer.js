import { getFileContent } from '../../../github/client.js';
import { pushDraftBranch, mergeBranchToStage, STAGE_BRANCH } from '../../lib/github-ops.js';
import { assertValidContent } from './js-data-splice.js';

// Shared push/merge/rollback lifecycle for every data-file adapter (today:
// data-array-content.js) — the parts that differ per-tenant (finding/
// computing the edit, from url_file_map config) stay in the adapter; this
// is only the GitHub push/merge/rollback mechanics, identical regardless
// of which file/tenant is involved. Kept separate from lib/js-data-splice.js,
// which stays pure/network-free so its string-parsing logic can be
// unit-tested without mocking GitHub.

export async function mergeToStageWithSnapshot(site, draft, filePath) {
  if (!draft.branch_name) return { ok: false, reason: 'no-branch', error: 'No branch has been pushed for this draft yet.' };
  // Snapshot the file's content BEFORE merging — this is what a later
  // rollback restores. Captured here (not at push time) so it reflects
  // whatever is actually about to be overwritten, even if other changes
  // landed on stage between this draft's branch push and its merge.
  const before = await getFileContent(site, filePath, STAGE_BRANCH);
  const merged = await mergeBranchToStage(site, draft, draft.branch_name);
  if (!merged.ok) return merged;
  return { ...merged, previousContent: before?.content ?? null, filePath };
}

// Pushes a real branch restoring the exact snapshot captured at merge
// time — never a silent/direct revert. The caller (action-center's
// /rollback route) merges this branch through the same human-triggered
// flow every other change goes through.
export async function rollbackFromSnapshot(site, draft, filePath, format = 'js-export-array') {
  const snapshot = draft.rollback_snapshot;
  if (!snapshot?.content || snapshot.filePath !== filePath) {
    return { ok: false, reason: 'no-rollback-snapshot', error: 'No rollback snapshot available for this draft.' };
  }
  const check = assertValidContent(snapshot.content, format);
  if (!check.ok) {
    return { ok: false, reason: 'invalid-edit', error: `Stored rollback snapshot is not valid content (${check.error}) — refusing to restore it.` };
  }
  const rollbackDraft = { action_type: draft.action_type, id: `${draft.id}-rollback` };
  return pushDraftBranch(site, rollbackDraft, [{ path: filePath, content: snapshot.content }]);
}
