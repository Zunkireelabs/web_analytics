import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { runOrchestration } from '../agents/orchestrator.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';
import { buildRecommendations } from '../agents/lib/recommendations.js';
import { listGeneratorMeta, getGenerator } from '../generators/registry.js';
import {
  createDraft, listDrafts, getDraft, updateDraft, deleteDraft, submitDraftForApproval, approveDraft,
  markDraftImplemented, markDraftBranchPushed, markDraftMergedToStage, recordApplyFailure, recordMergeFailure,
  MERGE_MANDATORY_TYPES,
} from '../store/drafts.js';
import { getImplementerForGenerator } from '../implementers/registry.js';
import { getSiteById } from '../store/read.js';
import { runSiteDiscoveryIfDue } from '../job.js';

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
    res.json({ ...draft, summary });
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

router.post('/action-center/drafts/:id/approve', async (req, res, next) => {
  try {
    const draft = await approveDraft(req.siteId, req.params.id, req.userId);
    if (!draft) return res.status(404).json({ error: 'Draft not found, or not submitted for approval' });
    res.json(draft);
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

// Zero-write dry run — the real file diff a reviewer sees BEFORE approving,
// not just the abstract draft content. Available any time a draft isn't
// implemented yet (not gated to 'approved') since this never touches
// GitHub. Uses the exact same merge function /apply below does, so what's
// previewed here and what actually gets written can never diverge.
router.get('/action-center/drafts/:id/preview', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.status === 'implemented') return res.status(400).json({ error: 'Already implemented — nothing to preview.' });

    const site = await getSiteById(req.siteId);
    if (!site.repo_owner || !site.repo_name) return res.status(400).json({ error: 'This site has no repository configured yet — connect one first.' });

    const implementer = await getImplementerForGenerator(draft.action_type);
    if (!implementer) return res.status(400).json({ error: `No implementer wired for "${draft.action_type}" yet` });
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

    const implementer = await getImplementerForGenerator(draft.action_type);
    if (!implementer) return res.status(400).json({ error: `No implementer wired for "${draft.action_type}" yet` });

    const result = await implementer.apply(site, draft);
    if (!result.ok) {
      await recordApplyFailure(req.siteId, draft.id, result.error);
      return res.status(422).json({ error: result.error, reason: result.reason });
    }
    const updated = await markDraftBranchPushed(req.siteId, draft.id, { branchName: result.branchName, implementerId: implementer.meta.id });
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
    const implementer = await getImplementerForGenerator(draft.action_type);
    if (!implementer || typeof implementer.mergeToStage !== 'function') return res.status(400).json({ error: `No merge step wired for "${draft.action_type}" yet` });

    const result = await implementer.mergeToStage(site, draft);
    if (!result.ok) {
      await recordMergeFailure(req.siteId, draft.id, result.error);
      return res.status(422).json({ error: result.error, reason: result.reason });
    }
    await markDraftMergedToStage(req.siteId, draft.id, { mergeSha: result.mergeSha, mergeUrl: result.mergeUrl });
    const updated = await finalizeImplemented(req.siteId, draft.id, site);
    res.json(updated);
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
