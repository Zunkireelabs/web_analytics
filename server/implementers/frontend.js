import { resolveFile, resolveNewContentTarget, resolveNewContentTargetConfig, resolveNewContentUrl, resolveNewContentLayout, resolveTranslationTarget, resolveMissingPageTarget } from './lib/url-file-map.js';
import { deriveNewContentContract, deriveContractFromSourceFile } from './lib/newcontent-contract.js';
import { getFileContent } from '../github/client.js';
import { pushDraftBranch, openPrForBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from './lib/github-ops.js';
import { renderLandingPageBody, renderBlogOutlineBody, renderTranslationBody, renderDirectAnswerBody, renderCompliancePageBody, renderMissingPageBody, extractPreservedFrontMatter } from './lib/newpage-render.js';
import { siteHasUsableDesignProfile, checkDesignIntegrityGate } from './lib/design-drift.js';

export const meta = {
  id: 'frontend',
  name: 'Frontend/Content Implementer',
  description: 'Places long-form draft content (landing pages, blog outlines, direct-answer sections, translated pages, trust/compliance pages) into the site\'s real templates as a pull request.',
  handles: ['landing-page', 'blog-outline', 'direct-answer', 'translation', 'cookie-policy', 'privacy-policy', 'terms-of-service', 'missing-page-create'],
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
// `repoDeps` is the seam for the repo reads the net-new-content branches do
// (newcontent-contract.js's getRepoTree/getFileContent, and its `cache`).
// Production never passes it — the defaults are the real GitHub client and the
// module-level contract cache. It exists because the layout a new page ends up
// declaring is decided by what is really in the repo, and a regression test
// for "this directory's posts declare no layout, so neither does ours" has to
// be able to state what is in the directory. Without it the only coverage
// possible was "no config -> no-file-mapping", which is precisely the branch
// where the bug could not happen.
export async function resolveTargetAndBody(site, draft, repoDeps = {}) {
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

  // The title each of the branches below slugifies into its file path — the
  // permalink must be resolved from the SAME title, or the page would be
  // written at one slug and declare it lives at another.
  if (actionType === 'landing-page') {
    const title = content.metaTitle || content.headline || content.target;
    const filePath = resolveNewContentTarget(site, 'landing-page', title);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["landing-page"] configured — add e.g. {"dir":"src/pages","extension":".njk"} via `npm run connect-repo` before this can be applied.' };
    }
    const permalink = resolveNewContentUrl(site, 'landing-page', title);
    // Same sibling-derived contract as blog-outline/direct-answer below, for
    // the same reason: a landing page written into src/pages inherits whatever
    // that directory's real pages do about layout, and a config-derived
    // `layout: base.njk` on a directory whose pages declare none (or declare a
    // different one) drops the new page out of its template exactly the way it
    // did on zunkireelabs.com's blog. resolveNewContentLayout stays as the
    // fallback for a directory with no readable siblings. No fieldNames: this
    // renderer emits nothing but layout/permalink/title/description, none of
    // which is aliased per site.
    const contract = await deriveNewContentContract(site, {
      ...resolveNewContentTargetConfig(site, 'landing-page'),
    }, repoDeps);
    const layout = contract.unknown ? resolveNewContentLayout(site, 'landing-page') : contract.layout;
    return { ok: true, filePath, body: renderLandingPageBody(content, site, { permalink, layout }), contentFormat: 'markdown' };
  }

  if (actionType === 'blog-outline') {
    const title = content.title || content.topic;
    const filePath = resolveNewContentTarget(site, 'blog-outline', title);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["blog-outline"] configured — add e.g. {"dir":"src/blog","extension":".md"} via `npm run connect-repo` before this can be applied.' };
    }
    const permalink = resolveNewContentUrl(site, 'blog-outline', title);
    // Siblings first: the posts already in this directory are the authority on
    // whether a post declares its own layout and what it calls its hero image.
    // resolveNewContentLayout stays as the fallback for a directory with no
    // readable siblings. See newcontent-contract.js for why.
    const contract = await deriveNewContentContract(site, {
      ...resolveNewContentTargetConfig(site, 'blog-outline'),
    }, repoDeps);
    const layout = contract.unknown ? resolveNewContentLayout(site, 'blog-outline') : contract.layout;
    return {
      ok: true,
      filePath,
      body: renderBlogOutlineBody(content, site, { permalink, layout, fieldNames: contract.fieldNames }),
      contentFormat: 'markdown',
    };
  }

  // Unlike every other branch here, the file path is NOT slugified from the
  // title and the permalink is NOT urlPattern-derived: both come from the
  // dead href this page exists to make resolve. The target directory is
  // derived from the siblings the decision was made on (see
  // resolveMissingPageTarget) rather than from a newContentTargets entry, so
  // this needs no per-site onboarding config — a site that has siblings under
  // the section already has everything required.
  if (actionType === 'missing-page-create') {
    const href = content.href;
    const siblings = Array.isArray(content.siblings) ? content.siblings : [];
    const target = href ? resolveMissingPageTarget(site, href, siblings) : null;
    if (!target) {
      return {
        ok: false,
        reason: 'no-file-mapping',
        error: `No url_file_map entry resolves any sibling page under ${href || 'this section'} to a real repo file, so there is no directory to create the page in — remove the dead link instead.`,
      };
    }
    let permalink = null;
    try { permalink = new URL(href).pathname; } catch { /* leave null — the build decides, same as every other renderer */ }
    // Siblings are real existing pages in this same directory, so they are a
    // strictly better contract source than the target-config path used by
    // landing-page/blog-outline above — deriveContractFromSourceFile reads the
    // actual file one of them resolves to.
    const contract = await deriveContractFromSourceFile(site, target.modelFile, {}, repoDeps).catch(() => ({ unknown: true }));
    const layout = contract.unknown ? null : contract.layout;
    return {
      ok: true,
      filePath: target.filePath,
      body: renderMissingPageBody(content, site, { permalink, layout }),
      contentFormat: 'markdown',
    };
  }

  if (actionType === 'direct-answer') {
    const title = content.title || content.heading || content.query;
    const filePath = resolveNewContentTarget(site, 'direct-answer', title);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["direct-answer"] configured — add e.g. {"dir":"src/answers","extension":".md"} via `npm run connect-repo` before this can be applied.' };
    }
    const permalink = resolveNewContentUrl(site, 'direct-answer', title);
    // Same sibling-derived contract as blog-outline: on this platform's own
    // first client both types write into the very same src/blog directory, so
    // a layout that is wrong for one is wrong for the other.
    const contract = await deriveNewContentContract(site, {
      ...resolveNewContentTargetConfig(site, 'direct-answer'),
    }, repoDeps);
    const layout = contract.unknown ? resolveNewContentLayout(site, 'direct-answer') : contract.layout;
    return { ok: true, filePath, body: renderDirectAnswerBody(content, site, { permalink, layout }), contentFormat: 'markdown' };
  }

  // No permalink for a translation: its target is a language-suffixed sibling
  // of the SOURCE page's real file (resolveTranslationTarget), not a
  // newContentTargets directory, so there is no urlPattern to resolve against
  // and no honest way to know the site's translated-URL convention. It keeps
  // today's behavior — the build decides — rather than guessing one.
  if (actionType === 'translation') {
    const sourcePath = resolveFile(site, content.page);
    if (!sourcePath) {
      return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches the source page "${content.page || '(none)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
    }
    const filePath = resolveTranslationTarget(sourcePath, content.targetLanguage);
    // No permalink (see above), but a translated page is still a brand-new
    // file that needs the site's real chrome around it — and unlike every
    // other type here, this one already knows the exact file it must look
    // like. A translation is the SAME page in another language, so its
    // authority is that source page's own front matter, not a majority vote
    // over a directory that holds pages built on several different layouts
    // (see deriveContractFromSourceFile). resolveNewContentLayout stays as the
    // fallback for a source file that couldn't be read.
    const contract = await deriveContractFromSourceFile(site, sourcePath, {}, repoDeps);
    const layout = contract.unknown ? resolveNewContentLayout(site, 'translation') : contract.layout;
    return { ok: true, filePath, body: renderTranslationBody(content, site, { layout }), contentFormat: 'markdown' };
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
    const title = content.metaTitle || content.headline;
    const filePath = existingFile || resolveNewContentTarget(site, actionType, title);
    if (!filePath) {
      const pageHint = page ? ` (real target "${page}" isn't in url_file_map.pages either)` : '';
      return { ok: false, reason: 'no-file-mapping', error: `No url_file_map.newContentTargets["${actionType}"] configured${pageHint} — add one via \`npm run connect-repo\` before this can be applied.` };
    }
    // Overwriting a real, already-linked page — preserve its own
    // layout/permalink front matter (see extractPreservedFrontMatter) so
    // this doesn't silently orphan the live URL.
    const readFile = repoDeps.getFileContent || getFileContent;
    const existing = existingFile ? await readFile(site, existingFile, baseBranch(site)) : null;
    const preserved = extractPreservedFrontMatter(existing?.content);
    // Only for the genuinely-new-file case — an existing page's own preserved
    // permalink always wins inside the renderer.
    const permalink = existingFile ? null : resolveNewContentUrl(site, actionType, title);
    // Only the genuinely-new-file case derives a contract. Overwriting a real
    // page is already answered by that page's own preserved front matter
    // (which wins inside the renderer regardless), so sampling its neighbours
    // would spend a repo tree plus eight file reads on an answer nothing uses.
    // For a NEW compliance page the directory's siblings are the authority,
    // same as every other net-new type — a `layout: base.njk` emitted into a
    // src/pages whose pages declare none overrides the directory's real one.
    const contract = existingFile
      ? null
      : await deriveNewContentContract(site, { ...resolveNewContentTargetConfig(site, actionType) }, repoDeps);
    const layout = contract && !contract.unknown
      ? contract.layout
      : resolveNewContentLayout(site, actionType);
    return { ok: true, filePath, body: renderCompliancePageBody(content, preserved, site, { permalink, layout }), contentFormat: 'markdown' };
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

  // The design-integrity gate's frontend.js counterpart to backend.js's own
  // computeMarkerMerge check (design-integrity-gate proposal, change 04).
  // Every FRONTEND_ACTION_TYPES page is styled body copy — there is no
  // schema-only mode here the way marker-merge.js's content types have — and
  // newpage-render.js's wrapInSiteProse falls through to a live
  // projectPageWrapper(designProfile) projection whenever no repo-verified
  // contentWrapper is configured, same "on-the-fly, unstamped" exposure
  // checkDesignIntegrityGate closes automatically (verifyProfileRoles,
  // design-drift.js) rather than via human sign-off. Simpler than trying to
  // detect whether THIS specific draft's wrapper actually came from the
  // profile (which would mean re-deriving wrapInSiteProse's own branching
  // here and risking the two drifting apart) — a confirmed role-mismatch
  // quarantines this one draft, never the whole site's other pages.
  if (siteHasUsableDesignProfile(site)) {
    const gate = await checkDesignIntegrityGate(site, { actionType: draft.action_type, findingId: draft.finding_id });
    if (!gate.ok) {
      return {
        ok: false, reason: 'design-integrity-failed',
        error: gate.error || `${gate.field} uses classes this site only ever uses for its ${gate.observedAs}.`,
      };
    }
  }

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
