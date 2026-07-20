import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { runOrchestration } from '../agents/orchestrator.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';
import { buildRecommendations } from '../agents/lib/recommendations.js';
import { listGeneratorMeta, getGenerator } from '../generators/registry.js';
import {
  createDraft, listDrafts, getDraft, updateDraft, deleteDraft, submitDraftForApproval, approveDraft,
  markDraftImplemented, markDraftBranchPushed, markDraftMergedToStage, recordApplyFailure, recordMergeFailure,
  recordGscNotification, MERGE_MANDATORY_TYPES,
} from '../store/drafts.js';
import { resolveImplementerForApply, resolveImplementerForMerge } from '../implementers/resolve.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { getFileContent } from '../github/client.js';
import { STAGE_BRANCH, mergeBranchToStage } from '../implementers/lib/github-ops.js';
import { inspectRenderMode, INSPECTABLE_ACTION_TYPES } from '../implementers/lib/render-inspector.js';
import { getSiteById } from '../store/read.js';
import { runSiteDiscoveryIfDue } from '../job.js';
import { notifyOfPageChange } from '../ingest/gsc-technical.js';

// Best-effort post-merge Search Console notification (multi-tenant
// refactor Part 3) — never blocks or fails the caller's response, since
// the merge itself already succeeded by the time this runs; a
// notification failure is real but secondary information, recorded for
// visibility (recordGscNotification) rather than surfaced as an error.
async function notifyGscBestEffort(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  if (!page) return;
  try {
    const result = await notifyOfPageChange(site, page);
    await recordGscNotification(site.id, draft.id, result);
  } catch (err) {
    console.error(`[action-center] GSC notification failed for draft ${draft.id}:`, err.message);
  }
}

// Best-effort, informational only — shown right after generation so staff
// see the likely render mode before even submitting for approval. Never
// blocks draft creation: a missing repo/file-mapping/fetch failure just
// means no hint is attached. Approval re-inspects fresh regardless (the
// page may change between generation and approval), so this is never the
// authoritative decision, only an early preview of it.
async function buildRenderModeHint(siteId, actionType, page) {
  if (!page || !INSPECTABLE_ACTION_TYPES.includes(actionType)) return null;
  try {
    const site = await getSiteById(siteId);
    if (!site?.repo_owner || !site?.repo_name) return null;
    const filePath = resolveFile(site, page);
    if (!filePath) return null;
    const file = await getFileContent(site, filePath, STAGE_BRANCH);
    if (!file) return null;
    return await inspectRenderMode(file.content, actionType);
  } catch {
    return null;
  }
}

const router = Router();
router.use(requireAuth, requireInternalSite);

// Most recent persisted recommendations — instant, may be stale. `Refresh`
// below re-runs the agents fresh.
router.get('/action-center/recommendations', async (req, res, next) => {
  try {
    res.json(await buildRecommendations(req.siteId));
  } catch (e) { next(e); }
});

// Re-runs the 6 recommendation-bearing agents fresh (each several seconds —
// real page fetches + LLM calls) for the given range via the shared
// orchestrator (persisting each sub-agent run like any other agent run),
// then rebuilds the recommendation list from the fresh data.
router.post('/action-center/recommendations/refresh', async (req, res, next) => {
  try {
    const { start, end } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: 'start and end are required' });
    await runOrchestration({ siteId: req.siteId, start, end, agentIds: RECOMMENDATION_AGENT_IDS, persistSubAgentRuns: true });
    res.json(await buildRecommendations(req.siteId));
  } catch (e) { next(e); }
});

router.get('/action-center/generators', async (req, res, next) => {
  try {
    res.json(await listGeneratorMeta());
  } catch (e) { next(e); }
});

// Runs one generator and persists the result as a new draft. Never writes
// anywhere else — no publish path exists.
router.post('/action-center/generate', async (req, res, next) => {
  try {
    const { generatorId, params, source, findingId } = req.body || {};
    if (!generatorId) return res.status(400).json({ error: 'generatorId is required' });
    const generator = await getGenerator(generatorId);
    if (!generator) return res.status(404).json({ error: `Unknown generator "${generatorId}"` });

    const { content, summary } = await generator.generate({ siteId: req.siteId, params: params || {} });
    const draft = await createDraft(req.siteId, {
      actionType: generatorId, source: source || 'manual', input: params || {}, content, findingId,
    });
    const renderModeHint = await buildRenderModeHint(req.siteId, generatorId, params?.page || content?.page);
    res.json({ ...draft, summary, renderModeHint });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.get('/action-center/drafts', async (req, res, next) => {
  try {
    const { actionType, status } = req.query;
    res.json(await listDrafts(req.siteId, { actionType, status }));
  } catch (e) { next(e); }
});

router.get('/action-center/drafts/:id', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json(draft);
  } catch (e) { next(e); }
});

// Edit + Save Draft — content only, valid at any point before approval.
router.put('/action-center/drafts/:id', async (req, res, next) => {
  try {
    const { content } = req.body || {};
    if (content == null) return res.status(400).json({ error: 'content is required' });
    const draft = await updateDraft(req.siteId, req.params.id, { content });
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json(draft);
  } catch (e) { next(e); }
});

// Approval lifecycle: draft/edited -> submitted_for_approval -> approved ->
// implemented. Each step 404s if the draft isn't in the state it requires
// (guards against e.g. approving something never submitted) rather than
// silently no-op'ing.
router.post('/action-center/drafts/:id/submit', async (req, res, next) => {
  try {
    const draft = await submitDraftForApproval(req.siteId, req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found, or not in a submittable state' });
    res.json(draft);
  } catch (e) { next(e); }
});

// Approval now auto-publishes: the moment a draft is approved, it's pushed
// to a real branch and merged straight into `stage` (auto-completing to
// 'implemented') in the same request — no separate manual Push Branch/Merge
// to Stage clicks.
//
// Gated on a real deployability check BEFORE the status flip: resolves the
// implementer and, if it exposes preview(), runs the exact same zero-write
// dry run GET .../preview already uses — a page with no file mapping, no
// markers configured, or an uncertain render mode gets rejected here,
// status staying at 'submitted_for_approval', instead of flipping to
// 'approved' and only then discovering it can't actually deploy (which
// used to leave "Approved" not really meaning "confirmed deployable," for
// any page, any client — the exact root cause behind the homepage-FAQ and
// /compare/-FAQ drafts that got stuck this way). preview() and apply()'s
// internal computeChange() do end up computing the same thing twice (a
// second live GitHub read) — an accepted, minor cost for closing this gap,
// not worth a bigger refactor to avoid.
//
// Once past that, any failure below (GitHub API hiccup, a genuinely
// transient error) is a legitimate post-approval concern — same retryable
// apply_error path as before, via /push-branch and /merge-to-stage.
router.post('/action-center/drafts/:id/approve', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft || draft.status !== 'submitted_for_approval') {
      return res.status(404).json({ error: 'Draft not found, or not submitted for approval' });
    }

    const site = await getSiteById(req.siteId);
    let resolved = null;
    if (site.repo_owner && site.repo_name) {
      resolved = await resolveImplementerForApply(site, draft);
      if (resolved.error) return res.status(400).json({ error: resolved.error });
      if (typeof resolved.implementer.preview === 'function') {
        const previewResult = await resolved.implementer.preview(site, draft, { renderModeOverride: req.body?.renderMode });
        if (!previewResult.ok) {
          return res.status(422).json({
            error: previewResult.error, reason: previewResult.reason,
            confidence: previewResult.confidence, suggestedMode: previewResult.suggestedMode,
          });
        }
      }
    }

    const approvedDraft = await approveDraft(req.siteId, draft.id, req.userId);
    if (!approvedDraft) return res.status(404).json({ error: 'Draft not found, or not submitted for approval' });
    if (!resolved) return res.json(approvedDraft);

    const { implementer, implementerId } = resolved;
    const applyResult = await implementer.apply(site, approvedDraft, { renderModeOverride: req.body?.renderMode });
    if (!applyResult.ok) {
      await recordApplyFailure(req.siteId, approvedDraft.id, applyResult.error);
      if (applyResult.reason === 'render-mode-uncertain') {
        return res.status(422).json({
          error: applyResult.error, reason: applyResult.reason,
          confidence: applyResult.confidence, suggestedMode: applyResult.suggestedMode,
        });
      }
      return res.json(await getDraft(req.siteId, approvedDraft.id));
    }
    const branchPushedDraft = await markDraftBranchPushed(req.siteId, approvedDraft.id, { branchName: applyResult.branchName, implementerId });

    if (typeof implementer.mergeToStage !== 'function') return res.json(branchPushedDraft);

    const mergeResult = await implementer.mergeToStage(site, branchPushedDraft);
    if (!mergeResult.ok) {
      await recordMergeFailure(req.siteId, branchPushedDraft.id, mergeResult.error);
      return res.json(await getDraft(req.siteId, branchPushedDraft.id));
    }
    await markDraftMergedToStage(req.siteId, branchPushedDraft.id, {
      mergeSha: mergeResult.mergeSha, mergeUrl: mergeResult.mergeUrl,
      rollbackSnapshot: mergeResult.previousContent != null ? { filePath: mergeResult.filePath, content: mergeResult.previousContent } : null,
    });
    notifyGscBestEffort(site, branchPushedDraft);
    res.json(await finalizeImplemented(req.siteId, branchPushedDraft.id, site));
  } catch (e) { next(e); }
});

// Shared by /implemented and /merge-to-stage below: marks a draft
// implemented, then best-effort triggers a real sitemap/page-inventory
// refresh (never fails the caller's response — the draft is already
// correctly marked implemented at this point; runSiteDiscoveryIfDue is
// already cheap/idempotent when a real discovery isn't due yet).
async function finalizeImplemented(siteId, draftId, site) {
  const draft = await markDraftImplemented(siteId, draftId);
  if (draft) {
    try {
      await runSiteDiscoveryIfDue(site);
    } catch (err) {
      console.error(`[action-center] post-implement site discovery failed for site ${siteId}:`, err.message);
    }
  }
  return draft;
}

// Defensive/manual escape hatch only — every real generator type now
// auto-completes to 'implemented' the moment merge-to-stage succeeds (see
// below), so this route is only ever reached for a draft type with no real
// merge strategy at all (MERGE_MANDATORY_TYPES, store/drafts.js) — none
// exist today, kept for a future generator that might not have one yet.
router.post('/action-center/drafts/:id/implemented', async (req, res, next) => {
  try {
    const existing = await getDraft(req.siteId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Draft not found' });
    if (existing.status === 'approved' && !existing.branch_name && MERGE_MANDATORY_TYPES.includes(existing.action_type)) {
      return res.status(400).json({
        error: 'This change type requires a real merge into stage before it can be marked implemented — click "Push Branch" first.',
      });
    }

    const site = await getSiteById(req.siteId);
    const draft = await finalizeImplemented(req.siteId, req.params.id, site);
    if (!draft) return res.status(404).json({ error: 'Draft not found, or not yet approved' });
    res.json(draft);
  } catch (e) { next(e); }
});

// Two different things depending on status: for a draft that isn't
// implemented yet, a zero-write dry run of the real file diff a reviewer
// sees BEFORE approving — uses the exact same merge function /apply below
// does, so what's previewed here and what actually gets written can never
// diverge. For an already-implemented draft, there's no pending change to
// preview — this instead shows the real, current content sitting in the
// live marker(s), read fresh from GitHub every call (see backend.js's
// previewLiveMarkerContent), using whichever implementer/adapter actually
// did the merge (resolveImplementerForMerge, same persisted-at-push-time
// choice merge-to-stage itself uses) rather than re-resolving fresh.
router.get('/action-center/drafts/:id/preview', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const site = await getSiteById(req.siteId);
    if (!site.repo_owner || !site.repo_name) return res.status(400).json({ error: 'This site has no repository configured yet — connect one first.' });

    const resolved = draft.status === 'implemented'
      ? await resolveImplementerForMerge(draft)
      : await resolveImplementerForApply(site, draft);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { implementer } = resolved;
    if (typeof implementer.preview !== 'function') {
      return res.status(422).json({ error: `No preview available for "${draft.action_type}" yet.`, reason: 'merge-strategy-not-implemented' });
    }

    const result = await implementer.preview(site, draft);
    if (!result.ok) return res.status(422).json({ error: result.error, reason: result.reason });
    res.json(result);
  } catch (e) { next(e); }
});

// approved -> branch_pushed. Routes to whichever implementer (frontend/
// backend) handles this draft's generator type, pushes a real branch
// (forked from stage) with the real change, and persists either that real
// evidence or an honest failure — not merged yet. Staff reviews the real
// diff (Draft Preview panel — same computation apply() used) before the
// separate merge-to-stage step below.
router.post('/action-center/drafts/:id/push-branch', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft || draft.status !== 'approved') return res.status(404).json({ error: 'Draft not found, or not yet approved' });

    const site = await getSiteById(req.siteId);
    if (!site.repo_owner || !site.repo_name) return res.status(400).json({ error: 'This site has no repository configured yet — run `npm run connect-repo` first.' });

    const resolved = await resolveImplementerForApply(site, draft);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { implementer, implementerId } = resolved;

    const result = await implementer.apply(site, draft, { renderModeOverride: req.body?.renderMode });
    if (!result.ok) {
      await recordApplyFailure(req.siteId, draft.id, result.error);
      return res.status(422).json({
        error: result.error, reason: result.reason,
        confidence: result.confidence, suggestedMode: result.suggestedMode,
      });
    }
    const updated = await markDraftBranchPushed(req.siteId, draft.id, { branchName: result.branchName, implementerId });
    res.json(updated);
  } catch (e) { next(e); }
});

// branch_pushed -> merged_to_stage -> implemented, in one real action.
// Merges the branch already pushed above directly into `stage` — no PR
// (see server/implementers/lib/github-ops.js and
// ~/Travel/ci-cd-deployment-master-guide: stage has no protection rules and
// deploys automatically). A real merge into stage IS the real evidence this
// platform can ever have — promoting stage -> main/production is entirely
// manual and outside this app's visibility, so there's no further real
// signal worth waiting on a separate human click for. Auto-completes
// straight through to 'implemented' the moment the merge succeeds.
router.post('/action-center/drafts/:id/merge-to-stage', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft || draft.status !== 'branch_pushed') return res.status(404).json({ error: 'Draft not found, or has no pushed branch yet' });

    const site = await getSiteById(req.siteId);
    const resolved = await resolveImplementerForMerge(draft);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { implementer } = resolved;
    if (typeof implementer.mergeToStage !== 'function') return res.status(400).json({ error: `No merge step wired for "${draft.action_type}" yet` });

    const result = await implementer.mergeToStage(site, draft);
    if (!result.ok) {
      await recordMergeFailure(req.siteId, draft.id, result.error);
      return res.status(422).json({ error: result.error, reason: result.reason });
    }
    await markDraftMergedToStage(req.siteId, draft.id, {
      mergeSha: result.mergeSha, mergeUrl: result.mergeUrl,
      rollbackSnapshot: result.previousContent != null ? { filePath: result.filePath, content: result.previousContent } : null,
    });
    notifyGscBestEffort(site, draft);
    const updated = await finalizeImplemented(req.siteId, draft.id, site);
    res.json(updated);
  } catch (e) { next(e); }
});

// Restores a merged draft's target file to exactly what it was right
// before this draft's merge — only available for draft types whose writer
// captured a rollback_snapshot at merge time (currently data-array-content.js,
// the generic data-file adapter). Never a silent/direct revert: pushes a
// real new branch with the restored content, then merges it through the
// same real, auditable flow as every other change — the merge commit
// itself is the record of what happened and when.
router.post('/action-center/drafts/:id/rollback', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!draft.rollback_snapshot) return res.status(400).json({ error: 'No rollback snapshot available for this draft.' });

    const site = await getSiteById(req.siteId);
    const resolved = await resolveImplementerForMerge(draft);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { implementer } = resolved;
    if (typeof implementer.rollback !== 'function') return res.status(400).json({ error: `No rollback available for "${draft.action_type}" yet.` });

    const pushed = await implementer.rollback(site, draft);
    if (!pushed.ok) return res.status(422).json({ error: pushed.error, reason: pushed.reason });

    const merged = await mergeBranchToStage(site, draft, pushed.branchName);
    if (!merged.ok) return res.status(422).json({ error: merged.error, reason: merged.reason });

    res.json({ ok: true, mergeSha: merged.mergeSha, mergeUrl: merged.mergeUrl, branchName: pushed.branchName });
  } catch (e) { next(e); }
});

router.delete('/action-center/drafts/:id', async (req, res, next) => {
  try {
    const ok = await deleteDraft(req.siteId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Draft not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
