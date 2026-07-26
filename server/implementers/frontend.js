import { resolveFile, resolveNewContentTarget, resolveTranslationTarget } from './lib/url-file-map.js';
import { getFileContent } from '../github/client.js';
import { pushDraftBranch, openPrForBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from './lib/github-ops.js';
import { renderLandingPageBody, renderBlogOutlineBody, renderTranslationBody } from './lib/newpage-render.js';

export const meta = {
  id: 'frontend',
  name: 'Frontend/Content Implementer',
  description: 'Places long-form draft content (landing pages, blog outlines, translated pages) into the site\'s real templates as a pull request.',
  handles: ['landing-page', 'blog-outline', 'translation'],
};

// landing-page/blog-outline are net-new content — resolveNewContentTarget
// gives a deterministic new file path, removing the "don't corrupt an
// existing file" risk backend.js's marker-splice has to guard against.
// translation targets a language-suffixed sibling of the real SOURCE page's
// resolved path (see resolveTranslationTarget). All three then render a
// real, minimal Markdown-with-front-matter body (lib/newpage-render.js) —
// shared by preview() and apply() below so they can never diverge.
async function resolveTargetAndBody(site, draft) {
  const actionType = draft.action_type;
  const content = draft.content || {};

  if (actionType === 'landing-page') {
    const filePath = resolveNewContentTarget(site, 'landing-page', content.metaTitle || content.headline || content.target);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["landing-page"] configured — add e.g. {"dir":"src/pages","extension":".njk"} via `npm run connect-repo` before this can be applied.' };
    }
    return { ok: true, filePath, body: renderLandingPageBody(content) };
  }

  if (actionType === 'blog-outline') {
    const filePath = resolveNewContentTarget(site, 'blog-outline', content.title || content.topic);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["blog-outline"] configured — add e.g. {"dir":"src/blog","extension":".md"} via `npm run connect-repo` before this can be applied.' };
    }
    return { ok: true, filePath, body: renderBlogOutlineBody(content) };
  }

  if (actionType === 'translation') {
    const sourcePath = resolveFile(site, content.page);
    if (!sourcePath) {
      return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches the source page "${content.page || '(none)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
    }
    const filePath = resolveTranslationTarget(sourcePath, content.targetLanguage);
    return { ok: true, filePath, body: renderTranslationBody(content) };
  }

  return { ok: false, reason: 'merge-strategy-not-implemented', error: `No merge strategy for action type "${actionType}".` };
}

// Pushes a real branch (forked from the site's default branch) with the
// real new-file content — not merged yet (see mergeToStage below). Staff
// reviews the real diff (Draft Preview panel, unchanged — same
// resolveTargetAndBody output) before deciding to merge the PR.
export async function apply(site, draft) {
  const resolved = await resolveTargetAndBody(site, draft);
  if (!resolved.ok) return resolved;
  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  return pushDraftBranch(site, draft, [{ path: resolved.filePath, content: resolved.body }], batchInfo);
}

// branch_pushed -> PR opened into the site's default branch (human merges
// on GitHub). Despite the name — kept as-is because implementers/registry.js
// checks for this exact export name at load time (see
// server/implementers/registry.js) — this doesn't merge into stage at all,
// it opens a PR. draft.branch_name is already real (persisted by
// markDraftBranchPushed after apply() above succeeded) — this step only
// opens the PR, no new file writes.
export async function mergeToStage(site, draft) {
  if (!draft.branch_name) return { ok: false, reason: 'no-branch', error: 'No branch has been pushed for this draft yet.' };
  return openPrForBranch(site, draft, draft.branch_name);
}

// Zero-write dry run, same shared-computation principle as backend.js's
// preview(): a brand-new file's "before" is simply whatever's on that path
// today (empty/none for a genuinely new page, real existing content if a
// prior attempt already opened this exact file, e.g. a retried translation).
export async function preview(site, draft) {
  const resolved = await resolveTargetAndBody(site, draft);
  if (!resolved.ok) return resolved;
  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  const branch = batchInfo.exists ? batchInfo.branchName : baseBranch(site);
  const existing = await getFileContent(site, resolved.filePath, branch);
  return {
    ok: true,
    filePath: resolved.filePath,
    oldContent: existing?.content || '',
    newContent: resolved.body,
    changedRegions: [{ field: draft.action_type, before: existing?.content || '(new file)', after: resolved.body }],
  };
}
