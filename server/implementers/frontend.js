import { resolveFile, resolveNewContentTarget, resolveTranslationTarget } from './lib/url-file-map.js';
import { getFileContent } from '../github/client.js';
import { pushDraftBranch, openPrForBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from './lib/github-ops.js';
import { renderLandingPageBody, renderBlogOutlineBody, renderTranslationBody, renderDirectAnswerBody, renderCompliancePageBody, extractPreservedFrontMatter } from './lib/newpage-render.js';

export const meta = {
  id: 'frontend',
  name: 'Frontend/Content Implementer',
  description: 'Places long-form draft content (landing pages, blog outlines, direct-answer sections, translated pages, trust/compliance pages) into the site\'s real templates as a pull request.',
  handles: ['landing-page', 'blog-outline', 'direct-answer', 'translation', 'cookie-policy', 'privacy-policy', 'terms-of-service'],
};

export const COMPLIANCE_ACTION_TYPES = new Set(['cookie-policy', 'privacy-policy', 'terms-of-service']);

// Same set as meta.handles, as a Set — routes/action-center.js's
// generateDraft uses this to decide which action types get their full
// design/render/validate pipeline run at generation time (see this file's
// resolveTargetAndBody).
export const FRONTEND_ACTION_TYPES = new Set(meta.handles);

// landing-page/blog-outline are net-new content — resolveNewContentTarget
// gives a deterministic new file path, removing the "don't corrupt an
// existing file" risk backend.js's marker-splice has to guard against.
// translation targets a language-suffixed sibling of the real SOURCE page's
// resolved path (see resolveTranslationTarget). All three then render a
// real, minimal Markdown-with-front-matter body (lib/newpage-render.js) —
// shared by preview() and apply() below so they can never diverge. Also
// exported for routes/action-center.js's generateDraft — computing this
// (design/template resolution + render) at generation time, BEFORE a draft
// ever reaches Action Center for review, is what lets approval become a
// pure "push the already-prepared bytes" action instead of recomputing.
export async function resolveTargetAndBody(site, draft) {
  // Generation-time-prepared fast path: generateDraft (action-center.js)
  // already computed and rendering-gate-validated this exact output before
  // the draft was ever created, using the SAME resolveTargetAndBody this
  // function is. Reusing it verbatim (rather than recomputing — the two
  // would always produce the same bytes for an unedited draft anyway) is
  // what makes approval a pure "push the already-prepared thing" action
  // with no fresh generation/design work happening at click-time.
  // updateDraft (store/drafts.js) clears these two columns back to NULL the
  // moment a human edits draft.content, so an edited draft always falls
  // through to a fresh, correct recompute below — never a stale cached body.
  if (draft.rendered_body != null && draft.target_file_path != null) {
    // Every branch below always produces contentFormat: 'markdown' — the
    // one constant this fast path can safely assume without its own column.
    return { ok: true, filePath: draft.target_file_path, body: draft.rendered_body, contentFormat: 'markdown' };
  }

  const actionType = draft.action_type;
  const content = draft.content || {};

  if (actionType === 'landing-page') {
    const filePath = resolveNewContentTarget(site, 'landing-page', content.metaTitle || content.headline || content.target);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["landing-page"] configured — add e.g. {"dir":"src/pages","extension":".njk"} via `npm run connect-repo` before this can be applied.' };
    }
    return { ok: true, filePath, body: renderLandingPageBody(content, site), contentFormat: 'markdown' };
  }

  if (actionType === 'blog-outline') {
    const filePath = resolveNewContentTarget(site, 'blog-outline', content.title || content.topic);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["blog-outline"] configured — add e.g. {"dir":"src/blog","extension":".md"} via `npm run connect-repo` before this can be applied.' };
    }
    return { ok: true, filePath, body: renderBlogOutlineBody(content, site), contentFormat: 'markdown' };
  }

  if (actionType === 'direct-answer') {
    const filePath = resolveNewContentTarget(site, 'direct-answer', content.title || content.heading || content.query);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["direct-answer"] configured — add e.g. {"dir":"src/answers","extension":".md"} via `npm run connect-repo` before this can be applied.' };
    }
    return { ok: true, filePath, body: renderDirectAnswerBody(content, site), contentFormat: 'markdown' };
  }

  if (actionType === 'translation') {
    const sourcePath = resolveFile(site, content.page);
    if (!sourcePath) {
      return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches the source page "${content.page || '(none)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
    }
    const filePath = resolveTranslationTarget(sourcePath, content.targetLanguage);
    return { ok: true, filePath, body: renderTranslationBody(content, site), contentFormat: 'markdown' };
  }

  if (COMPLIANCE_ACTION_TYPES.has(actionType)) {
    // A real, already-linked page (trust-compliance.js's 'broken' finding —
    // homepage links to it, but it doesn't render real content) should be
    // overwritten in place via the normal pages[] mapping, not shadowed by
    // a second, unlinked page at a slugified path. Only fall back to
    // resolveNewContentTarget when there's no existing page to target (the
    // 'missing' finding — homepage has no link to a page at all yet) or the
    // site hasn't mapped that URL in url_file_map.pages.
    const page = content.page || draft.input?.page;
    const existingFile = page ? resolveFile(site, page) : null;
    const filePath = existingFile || resolveNewContentTarget(site, actionType, content.metaTitle || content.headline);
    if (!filePath) {
      const pageHint = page ? ` (real target "${page}" isn't in url_file_map.pages either)` : '';
      return { ok: false, reason: 'no-file-mapping', error: `No url_file_map.newContentTargets["${actionType}"] configured${pageHint} — add one via \`npm run connect-repo\` before this can be applied.` };
    }
    // Overwriting a real, already-linked page — preserve its own
    // layout/permalink front matter (see extractPreservedFrontMatter) so
    // this doesn't silently orphan the live URL.
    const existing = existingFile ? await getFileContent(site, existingFile, baseBranch(site)) : null;
    const preserved = extractPreservedFrontMatter(existing?.content);
    return { ok: true, filePath, body: renderCompliancePageBody(content, preserved, site), contentFormat: 'markdown' };
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
  return pushDraftBranch(site, draft, [{
    path: resolved.filePath, content: resolved.body,
    contentFormat: resolved.contentFormat, actionType: draft.action_type,
  }], batchInfo);
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
    contentFormat: resolved.contentFormat,
    changedRegions: [{ field: draft.action_type, before: existing?.content || '(new file)', after: resolved.body }],
  };
}
