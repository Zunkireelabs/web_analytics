import { Router } from 'express';
import { requireAuth } from './login.js';
import { runOrchestration } from '../agents/orchestrator.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';
import { buildRecommendations } from '../agents/lib/recommendations.js';
import { agenticOrchestrationEnabled, runAgenticLoop } from '../agents/lib/agentic-orchestrator.js';
import { getLatestAgentRuns } from '../agents/lib/fresh-runs.js';
import { listAgentMeta } from '../agents/registry.js';
import { listGeneratorMeta, getGenerator } from '../generators/registry.js';
import {
  createDraft, getDraftByFindingId, listDrafts, getDraft, updateDraft, deleteDraft, submitDraftForApproval, approveDraft,
  markDraftImplemented, markDraftAbandoned, markDraftBranchPushed, markDraftPrOpened, recordPrState, recordApplyFailure, recordMergeFailure,
  recordGscNotification, countSiblingDraftsOnBranch, countVisibleFaqDrafts, MERGE_MANDATORY_TYPES,
} from '../store/drafts.js';
import { resolveImplementerForApply, resolveImplementerForMerge } from '../implementers/resolve.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { getFileContent, getPullRequest } from '../github/client.js';
import { baseBranch, openRollbackPr } from '../implementers/lib/github-ops.js';
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

// Shared convention for the 4 automation-tier route handlers below (approve,
// push-branch, open-pr, check-pr-status) and their MCP tool counterparts
// (mcp-server/tools/automation.js): throw an Error carrying `.status` plus
// whichever extra fields (reason/confidence/suggestedMode/draftStatus) the
// original inline res.status(...).json({...}) calls used to send, so both
// callers can reconstruct the exact same response shape from one thrown value.
function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

function sendHttpError(res, e) {
  const body = { error: e.message };
  if (e.reason !== undefined) body.reason = e.reason;
  if (e.confidence !== undefined) body.confidence = e.confidence;
  if (e.suggestedMode !== undefined) body.suggestedMode = e.suggestedMode;
  if (e.draftStatus !== undefined) body.status = e.draftStatus;
  if (e.attempted !== undefined) body.attempted = e.attempted;
  res.status(e.status).json(body);
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
    const file = await getFileContent(site, filePath, baseBranch(site));
    if (!file) return null;
    const visibleFaqCount = await countVisibleFaqDrafts(siteId);
    return await inspectRenderMode(file.content, actionType, { visibleFaqCount, visibleFaqCap: site.visible_faq_cap });
  } catch {
    return null;
  }
}

const router = Router();
router.use(requireAuth);

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
// One line per recommendation-bearing agent: its real description and how
// long ago it last ran (or "never run") — the only signal the agentic
// selection loop has to decide what's worth refreshing, mirroring
// copilot.js's staleAgentIds 24h-staleness convention.
// Exported so server/routes/command-center.js's own refresh route can reuse
// the exact same real staleness signal instead of re-deriving it.
export async function buildStalenessContext(siteId) {
  const [meta, runs] = await Promise.all([
    listAgentMeta(),
    getLatestAgentRuns(siteId, RECOMMENDATION_AGENT_IDS),
  ]);
  const nameById = new Map(meta.map((m) => [m.id, m]));
  const byId = new Map(runs.map((r) => [r.agent_id, r]));
  return RECOMMENDATION_AGENT_IDS.map((id) => {
    const run = byId.get(id);
    const age = run ? `last ran ${Math.round((Date.now() - new Date(run.created_at).getTime()) / 3600000)}h ago` : 'never run';
    return `- ${id}: ${nameById.get(id)?.description || ''} (${age})`;
  }).join('\n');
}

// Exported so the MCP `refresh_recommendations` tool (mcp-server/tools/
// ai-actions.js) reuses this exact logic instead of duplicating it.
export async function refreshRecommendations(siteId, { start, end }) {
  if (agenticOrchestrationEnabled()) {
    try {
      const staleness = await buildStalenessContext(siteId);
      const { ranAgentIds } = await runAgenticLoop({ siteId, start, end, staleness, persistSubAgentRuns: true });
      console.log('[action-center] agentic loop selected:', ranAgentIds.length ? ranAgentIds.join(', ') : '(nothing needed refreshing)');
    } catch (e) {
      console.warn('[action-center] agentic selection failed, falling back to full refresh:', e.message);
      await runOrchestration({ siteId, start, end, agentIds: RECOMMENDATION_AGENT_IDS, persistSubAgentRuns: true });
    }
  } else {
    await runOrchestration({ siteId, start, end, agentIds: RECOMMENDATION_AGENT_IDS, persistSubAgentRuns: true });
  }
  return buildRecommendations(siteId);
}

router.post('/action-center/recommendations/refresh', async (req, res, next) => {
  try {
    const { start, end } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: 'start and end are required' });
    res.json(await refreshRecommendations(req.siteId, { start, end }));
  } catch (e) { next(e); }
});

router.get('/action-center/generators', async (req, res, next) => {
  try {
    res.json(await listGeneratorMeta());
  } catch (e) { next(e); }
});

// Runs one generator and persists the result as a new draft. Never writes
// anywhere else — no publish path exists.
//
// Exported so the MCP `generate_draft` tool (mcp-server/tools/ai-actions.js)
// reuses this exact logic instead of duplicating it. Throws with a `.status`
// (400/404) for the route below to map to a response — same convention
// runAgent() (server/agents/runner.js) already uses.
export async function generateDraft(siteId, { generatorId, params, source, findingId } = {}) {
  if (!generatorId) { const err = new Error('generatorId is required'); err.status = 400; throw err; }
  const generator = await getGenerator(generatorId);
  if (!generator) { const err = new Error(`Unknown generator "${generatorId}"`); err.status = 404; throw err; }

  // Idempotent per finding: a retry, double-click, or a second tab must
  // never create a second draft row for the same finding — return the
  // one that already exists instead of generating (and billing an LLM
  // call for) a duplicate.
  if (findingId) {
    const existing = await getDraftByFindingId(siteId, findingId);
    if (existing) {
      const hintPage = existing.input?.page || existing.content?.page;
      const renderModeHint = await buildRenderModeHint(siteId, existing.action_type, hintPage);
      return { ...existing, renderModeHint };
    }
  }

  const { content, summary } = await generator.generate({ siteId, params: params || {} });
  const draft = await createDraft(siteId, {
    actionType: generatorId, source: source || 'manual', input: params || {}, content, findingId,
  });
  const renderModeHint = await buildRenderModeHint(siteId, generatorId, params?.page || content?.page);
  return { ...draft, summary, renderModeHint };
}

router.post('/action-center/generate', async (req, res, next) => {
  try {
    const { generatorId, params, source, findingId } = req.body || {};
    res.json(await generateDraft(req.siteId, { generatorId, params, source, findingId }));
  } catch (e) {
    if (e.status === 400 || e.status === 404) return res.status(e.status).json({ error: e.message });
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

// Approval auto-publishes as far as it safely can: the moment a draft is
// approved, it's pushed to a real branch and a real PR is opened against
// `main` in the same request — but it stops there. Merging that PR is now a
// manual human action on GitHub (see server/implementers/lib/github-ops.js's
// openPrForBranch), so this route can't auto-complete to 'implemented'
// anymore; that only happens once the Check PR Status action
// (POST .../check-pr-status below) confirms GitHub reports the PR merged.
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
// apply_error path as before, via /push-branch and /open-pr.
// Exported so the MCP `approve_draft` tool (mcp-server/tools/automation.js)
// reuses this exact logic instead of duplicating it. Note this can return a
// draft reflecting a *recorded* apply/merge failure (recordApplyFailure/
// recordMergeFailure) rather than throwing — those are legitimate,
// retryable post-approval states (see /push-branch, /open-pr), not errors
// this call itself failed with. Only a pre-approval rejection (bad
// implementer resolution, a failed preview, or an uncertain render mode)
// throws.
export async function approveAndPublishDraft(siteId, draftId, { userId, renderMode } = {}) {
  const draft = await getDraft(siteId, draftId);
  if (!draft || draft.status !== 'submitted_for_approval') {
    throw httpError(404, 'Draft not found, or not submitted for approval');
  }

  const site = await getSiteById(siteId);
  let resolved = null;
  if (site.repo_owner && site.repo_name) {
    resolved = await resolveImplementerForApply(site, draft);
    if (resolved.error) throw httpError(400, resolved.error);
    if (typeof resolved.implementer.preview === 'function') {
      const previewResult = await resolved.implementer.preview(site, draft, { renderModeOverride: renderMode });
      if (!previewResult.ok) {
        throw httpError(422, previewResult.error, {
          reason: previewResult.reason, confidence: previewResult.confidence, suggestedMode: previewResult.suggestedMode,
        });
      }
    }
  }

  const approvedDraft = await approveDraft(siteId, draft.id, userId);
  if (!approvedDraft) throw httpError(404, 'Draft not found, or not submitted for approval');
  if (!resolved) return approvedDraft;

  const { implementer, implementerId } = resolved;
  const applyResult = await implementer.apply(site, approvedDraft, { renderModeOverride: renderMode });
  if (!applyResult.ok) {
    const renderModeInfo = applyResult.reason === 'render-mode-uncertain'
      ? { reason: applyResult.error, confidence: applyResult.confidence, suggestedMode: applyResult.suggestedMode }
      : null;
    await recordApplyFailure(siteId, approvedDraft.id, applyResult.error, renderModeInfo);
    if (applyResult.reason === 'render-mode-uncertain') {
      // approveDraft() above already flipped this draft's real status to
      // 'approved' before implementer.apply() hit this — unlike the
      // earlier preview() check (which fires while still
      // submitted_for_approval), a retry against this exact draft can no
      // longer re-run approveDraft(). Including the real current status
      // lets the caller refresh instead of retrying against a state that's
      // no longer true.
      throw httpError(422, applyResult.error, {
        reason: applyResult.reason, confidence: applyResult.confidence, suggestedMode: applyResult.suggestedMode,
        draftStatus: approvedDraft.status,
      });
    }
    return getDraft(siteId, approvedDraft.id);
  }
  const branchPushedDraft = await markDraftBranchPushed(siteId, approvedDraft.id, { branchName: applyResult.branchName, implementerId, renderMode: applyResult.renderMode, appliedFiles: applyResult.appliedFiles });

  if (typeof implementer.mergeToStage !== 'function') return branchPushedDraft;

  const prResult = await implementer.mergeToStage(site, branchPushedDraft);
  if (!prResult.ok) {
    await recordMergeFailure(siteId, branchPushedDraft.id, prResult.error);
    return getDraft(siteId, branchPushedDraft.id);
  }
  return markDraftPrOpened(siteId, branchPushedDraft.id, {
    prNumber: prResult.prNumber, prUrl: prResult.prUrl,
    rollbackSnapshot: prResult.previousContent != null ? { filePath: prResult.filePath, content: prResult.previousContent } : null,
  });
}

router.post('/action-center/drafts/:id/approve', async (req, res, next) => {
  try {
    res.json(await approveAndPublishDraft(req.siteId, req.params.id, { userId: req.userId, renderMode: req.body?.renderMode }));
  } catch (e) {
    if (e.status) return sendHttpError(res, e);
    next(e);
  }
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
// above), so this route is only ever reached for a draft type with no real
// merge strategy at all (MERGE_MANDATORY_TYPES, store/drafts.js) — none
// exist today, kept for a future generator that might not have one yet.
//
// Exported so the MCP `mark_draft_implemented` tool reuses this logic. Sits
// in the `ai_actions` tier, not `automation` — it makes no external
// (GitHub/etc) call, only an internal status flip plus a best-effort local
// site-discovery refresh, so it doesn't cross the "touches an external
// system" line that defines the automation tier (see mcp-server/tools/
// automation.js's own comment).
export async function markDraftImplementedIfEligible(siteId, draftId) {
  const existing = await getDraft(siteId, draftId);
  if (!existing) throw httpError(404, 'Draft not found');
  if (existing.status === 'approved' && !existing.branch_name && MERGE_MANDATORY_TYPES.includes(existing.action_type)) {
    throw httpError(400, 'This change type requires a real merge into stage before it can be marked implemented — click "Push Branch" first.');
  }

  const site = await getSiteById(siteId);
  const draft = await finalizeImplemented(siteId, draftId, site);
  if (!draft) throw httpError(404, 'Draft not found, or not yet approved');
  return draft;
}

router.post('/action-center/drafts/:id/implemented', async (req, res, next) => {
  try {
    res.json(await markDraftImplementedIfEligible(req.siteId, req.params.id));
  } catch (e) {
    if (e.status) return sendHttpError(res, e);
    next(e);
  }
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
    if (!result.ok) return res.status(422).json({ error: result.error, reason: result.reason, attempted: result.attempted });
    res.json(result);
  } catch (e) { next(e); }
});

// approved -> branch_pushed. Routes to whichever implementer (frontend/
// backend) handles this draft's generator type, pushes a real branch
// (forked from the site's default branch) with the real change, and
// persists either that real evidence or an honest failure — not merged yet.
// Staff reviews the real diff (Draft Preview panel — same computation
// apply() used) before the separate open-PR step below.
// Exported so the MCP `push_draft_branch` tool reuses this exact logic.
export async function pushDraftBranch(siteId, draftId, { renderMode } = {}) {
  const draft = await getDraft(siteId, draftId);
  if (!draft || draft.status !== 'approved') throw httpError(404, 'Draft not found, or not yet approved');

  const site = await getSiteById(siteId);
  if (!site.repo_owner || !site.repo_name) throw httpError(400, 'This site has no repository configured yet — run `npm run connect-repo` first.');

  const resolved = await resolveImplementerForApply(site, draft);
  if (resolved.error) throw httpError(400, resolved.error);
  const { implementer, implementerId } = resolved;

  const result = await implementer.apply(site, draft, { renderModeOverride: renderMode });
  if (!result.ok) {
    const renderModeInfo = result.reason === 'render-mode-uncertain'
      ? { reason: result.error, confidence: result.confidence, suggestedMode: result.suggestedMode }
      : null;
    await recordApplyFailure(siteId, draft.id, result.error, renderModeInfo);
    throw httpError(422, result.error, { reason: result.reason, confidence: result.confidence, suggestedMode: result.suggestedMode, attempted: result.attempted });
  }
  return markDraftBranchPushed(siteId, draft.id, { branchName: result.branchName, implementerId, renderMode: result.renderMode, appliedFiles: result.appliedFiles });
}

router.post('/action-center/drafts/:id/push-branch', async (req, res, next) => {
  try {
    res.json(await pushDraftBranch(req.siteId, req.params.id, { renderMode: req.body?.renderMode }));
  } catch (e) {
    if (e.status) return sendHttpError(res, e);
    next(e);
  }
});

// branch_pushed -> pr_opened. Opens a real PR from the branch already
// pushed above into `main` (see server/implementers/lib/github-ops.js's
// openPrForBranch) — this is the manual retry path for when /approve's
// auto-cascade pushed a branch but failed to open the PR. Does NOT merge
// anything and does NOT mark the draft implemented — merging is now a
// manual human action on GitHub; see /check-pr-status below for how the app
// learns the PR merged.
// Exported so the MCP `open_draft_pr` tool reuses this exact logic.
export async function openDraftPr(siteId, draftId) {
  const draft = await getDraft(siteId, draftId);
  if (!draft || draft.status !== 'branch_pushed') throw httpError(404, 'Draft not found, or has no pushed branch yet');

  const site = await getSiteById(siteId);
  const resolved = await resolveImplementerForMerge(draft);
  if (resolved.error) throw httpError(400, resolved.error);
  const { implementer } = resolved;
  if (typeof implementer.mergeToStage !== 'function') throw httpError(400, `No PR step wired for "${draft.action_type}" yet`);

  const result = await implementer.mergeToStage(site, draft);
  if (!result.ok) {
    await recordMergeFailure(siteId, draft.id, result.error);
    throw httpError(422, result.error, { reason: result.reason });
  }
  return markDraftPrOpened(siteId, draft.id, {
    prNumber: result.prNumber, prUrl: result.prUrl,
    rollbackSnapshot: result.previousContent != null ? { filePath: result.filePath, content: result.previousContent } : null,
  });
}

router.post('/action-center/drafts/:id/open-pr', async (req, res, next) => {
  try {
    res.json(await openDraftPr(req.siteId, req.params.id));
  } catch (e) {
    if (e.status) return sendHttpError(res, e);
    next(e);
  }
});

// pr_opened -> implemented, once GitHub confirms the PR was actually merged;
// pr_opened -> abandoned if it closed without merging. Triggered three ways:
// the manual "Check PR Status" button, the GitHub webhook (routes/webhooks.js,
// fires on PR close/merge), and an hourly polling fallback (job.js's
// runPrStatusPollForAllSites) for sites where the webhook was never
// configured or a delivery was missed — all three call this exact function,
// so behavior can never diverge between them. Reads the PR's real current
// state straight from GitHub every call (getPullRequest), never inferred
// locally. Not merged yet also records GitHub's own mergeable_state, so a
// batch branch that's gone stale/conflicted (the root cause of a real
// incident) is visible in the UI instead of silently invisible until a human
// opens the PR on GitHub themselves. Merged fires the same post-publish
// steps /merge-to-stage used to (GSC notification, finalize to
// 'implemented'), now gated on real human-confirmed evidence instead of an
// automatic merge. Closed-without-merge instead abandons the draft, so its
// finding_id isn't locked out of Recommendations forever (see
// markDraftAbandoned/getDraftedFindingIds in store/drafts.js).
// Exported so the MCP `check_pr_status` tool reuses this exact logic.
export async function checkDraftPrStatus(siteId, draftId) {
  const draft = await getDraft(siteId, draftId);
  if (!draft || draft.status !== 'pr_opened' || !draft.pr_number) {
    throw httpError(404, 'Draft not found, or has no open PR to check');
  }

  const site = await getSiteById(siteId);
  let pr;
  try {
    pr = await getPullRequest(site, draft.pr_number);
  } catch (e) {
    throw httpError(502, `Could not read PR status from GitHub: ${e.message}`);
  }

  if (pr.merged) {
    await recordPrState(siteId, draft.id, 'merged');
    notifyGscBestEffort(site, draft);
    return finalizeImplemented(siteId, draft.id, site);
  }
  if (pr.state === 'closed') {
    // Closed without merging — the fix was abandoned, not shipped. Record
    // the real state first (audit trail), then release this draft's
    // finding_id lock (getDraftedFindingIds) so the underlying issue can
    // resurface as a fresh Recommendation instead of staying stuck at
    // 'pr_opened' forever with no way back into the pipeline.
    await recordPrState(siteId, draft.id, pr.state, pr.mergeableState);
    return markDraftAbandoned(siteId, draft.id, 'pr_closed_without_merge');
  }
  return recordPrState(siteId, draft.id, pr.state, pr.mergeableState);
}

router.post('/action-center/drafts/:id/check-pr-status', async (req, res, next) => {
  try {
    res.json(await checkDraftPrStatus(req.siteId, req.params.id));
  } catch (e) {
    if (e.status) return sendHttpError(res, e);
    next(e);
  }
});

// Restores a merged draft's target file to exactly what it was right
// before this draft's merge — only available for draft types whose writer
// captured a rollback_snapshot at merge time (currently data-array-content.js,
// the generic data-file adapter). Never a silent/direct revert, and never a
// direct/auto-merge onto production either: pushes a real new branch with
// the restored content, then opens a real PR into the site's default branch
// (main) — a human reviews and merges it on GitHub, same as every other
// change. This route only gets the PR open; it doesn't wait for it to merge.
router.post('/action-center/drafts/:id/rollback', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!draft.rollback_snapshot) return res.status(400).json({ error: 'No rollback snapshot available for this draft.' });

    const siblingCount = await countSiblingDraftsOnBranch(req.siteId, draft.branch_name, draft.id);
    if (siblingCount > 0) {
      return res.status(400).json({ error: `This draft's branch (${draft.branch_name}) is shared with ${siblingCount} other draft(s) — rollback is disabled to avoid clobbering their changes.` });
    }

    const site = await getSiteById(req.siteId);
    const resolved = await resolveImplementerForMerge(draft);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { implementer } = resolved;
    if (typeof implementer.rollback !== 'function') return res.status(400).json({ error: `No rollback available for "${draft.action_type}" yet.` });

    const pushed = await implementer.rollback(site, draft);
    if (!pushed.ok) return res.status(422).json({ error: pushed.error, reason: pushed.reason });

    const opened = await openRollbackPr(site, draft, pushed.branchName);
    if (!opened.ok) return res.status(422).json({ error: opened.error, reason: opened.reason });

    res.json({ ok: true, prNumber: opened.prNumber, prUrl: opened.prUrl, branchName: pushed.branchName });
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
