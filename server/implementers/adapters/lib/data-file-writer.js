import { getFileContent } from '../../../github/client.js';
import { pushDraftBranch, openPrForBranch, STAGE_BRANCH } from '../../lib/github-ops.js';
import { assertValidContent } from './js-data-splice.js';

// Shared push/open-PR/rollback lifecycle for every data-file adapter (today:
// data-array-content.js) — the parts that differ per-tenant (finding/
// computing the edit, from url_file_map config) stay in the adapter; this
// is only the GitHub push/PR/rollback mechanics, identical regardless
// of which file/tenant is involved. Kept separate from lib/js-data-splice.js,
// which stays pure/network-free so its string-parsing logic can be
// unit-tested without mocking GitHub.

export async function openPrWithSnapshot(site, draft, filePath) {
  if (!draft.branch_name) return { ok: false, reason: 'no-branch', error: 'No branch has been pushed for this draft yet.' };
  // Snapshot the file's content BEFORE the PR is opened — this is what a
  // later rollback restores. Captured here (not at push time) so it
  // reflects whatever is actually live on stage right before this draft
  // would overwrite it, even if other changes landed on stage between this
  // draft's branch push and now. Rollback itself still targets stage (see
  // action-center.js's /rollback), so the snapshot stays stage-relative
  // regardless of where this draft's own PR ends up merging.
  const before = await getFileContent(site, filePath, STAGE_BRANCH);
  const opened = await openPrForBranch(site, draft, draft.branch_name);
  if (!opened.ok) return opened;
  return { ...opened, previousContent: before?.content ?? null, filePath };
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
