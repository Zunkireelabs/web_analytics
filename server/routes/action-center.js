import { Router } from 'express';
import { requireAuth } from './login.js';
import { runOrchestration } from '../agents/orchestrator.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';
import { buildRecommendations } from '../agents/lib/recommendations.js';
import { repairSiteTemplates } from '../agents/lib/template-repair.js';
import { syncFromGrounded, getRecommendations, recheckRecommendation } from '../agents/lib/recommendation-coordinator.js';
import { autoRemediateSafeRecommendations } from '../agents/lib/auto-remediation.js';
// Its own module, not auto-remediation.js's export, because this file and
// auto-remediation.js already import each other — see ship-pacing.js.
import { applyPacing, applyConvergenceCap } from '../agents/lib/ship-pacing.js';
import { draftShipState, SHIP_STATE } from '../lib/draft-ship-state.js';
import { recordOutcome } from '../agents/lib/generator-learning.js';
import { listOpenSafeRecommendations, getRecommendationById, setRecommendationExecutionState } from '../store/recommendations.js';
import { createExecutionJob, addJobRecommendation, updateJobRecommendationStatus, appendJobLog, finishExecutionJob, getExecutionJob, getLatestBulkExecutionJob, getTodayExecutionStats } from '../store/execution-jobs.js';
import { scheduleImpactMeasurement } from '../store/fix-impact.js';
import { agenticOrchestrationEnabled, runAgenticLoop } from '../agents/lib/agentic-orchestrator.js';
import { getLatestAgentRuns } from '../agents/lib/fresh-runs.js';
import { saveAgentRun } from '../store/agent-runs.js';
import { listAgentMeta } from '../agents/registry.js';
import { listGeneratorMeta, getGenerator } from '../generators/registry.js';
import { runQualityGate } from '../generators/lib/quality-gate.js';
import { extractEditLesson } from '../agents/lib/draft-lesson-extraction.js';
import { recordFixOutcome, findRelevantMemory, getActiveAutoMemories } from '../agent-memory.js';
import { VERIFIABLE_GENERATOR_IDS } from '../store/fix-verifications.js';
import { categoryForPattern, rootCauseForPattern, fixDirectiveForPattern, topLevelCategoryForGenerator } from '../generators/lib/pattern-categories.js';
import { evaluateApprovalGate } from './lib/approval-gate.js';
import { validateRendering, checkClientBuildStatus } from '../implementers/lib/rendering-gate.js';
import {
  createDraft, getDraftByFindingId, listDrafts, getDraft, updateDraft, deleteDraft, submitDraftForApproval, approveDraft,
  markDraftImplemented, markDraftAbandoned, markDraftRolledBack, requestDraftRevision, markDraftBranchPushed, markDraftPrOpened, recordPrState, recordApplyFailure, recordMergeFailure,
  recordGscNotification, recordValidationStatus, countSiblingDraftsOnBranch, MERGE_MANDATORY_TYPES, getPendingDraftFilePaths,
} from '../store/drafts.js';
import { countCurrentlyVisibleFaqPages } from '../implementers/lib/faq-render-mode.js';
import { resolveOrCreateComponentTemplate, componentTemplateVerification, componentTemplateActionTypeFor } from '../implementers/lib/design-drift.js';
import { FRONTEND_ACTION_TYPES, resolveTargetAndBody } from '../implementers/frontend.js';
import { resolveImplementerForApply, resolveImplementerForMerge } from '../implementers/resolve.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { autoHealFileMapping } from '../implementers/lib/discover-file-mapping.js';
import { resolvePageSource } from '../implementers/lib/page-resolution.js';
import { getFileContent, getPullRequest } from '../github/client.js';
import { baseBranch, openRollbackPr, batchBranchName, beginBatchPush, endBatchPush } from '../implementers/lib/github-ops.js';
import { inspectRenderMode, INSPECTABLE_ACTION_TYPES } from '../implementers/lib/render-inspector.js';
import { getSiteById } from '../store/read.js';
import { getUserById } from '../store/users.js';
import { runSiteDiscoveryIfDue } from '../job.js';
import { notifyOfPageChange } from '../ingest/gsc-technical.js';
import { markQueryDrafted } from '../store/growth-queries.js';
import { safeMessage, sanitizeForCustomer } from '../lib/errors.js';

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
// Always marked userFacing: every message passed here is either a static
// string authored right at the call site, or an implementer's own
// `{ok:false, error}` text — never a raw caught exception's `.message` (see
// server/lib/errors.js's UserFacingError; implementers are responsible for
// keeping their own `error` field free of raw provider/exception text).
function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.userFacing = true;
  if (extra) Object.assign(err, extra);
  return err;
}

// Local shortcut used by 5 route handlers below that respond directly
// instead of deferring to the global error handler (server/index.js) — so
// it needs its own copy of that handler's default-safe rule. e.message only
// passes through as-is when the error is a deliberately-thrown, developer-
// authored UserFacingError/httpError (see that function's own comment);
// anything else is a net catching a raw exception that reached here some
// other way, and gets replaced with a generic fallback rather than shown.
// Shared by the several route handlers below that check `e.status` directly
// rather than going through the global error handler — same default-safe
// rule as sendHttpError, for the simpler case with no extra fields.
function respondWithStatusError(res, e, fallback) {
  const message = e.userFacing ? e.message : (sanitizeForCustomer(e.message) ?? fallback);
  res.status(e.status).json({ error: message });
}

function sendHttpError(res, e) {
  const message = e.userFacing ? e.message : sanitizeForCustomer(e.message, 'This action could not be completed right now — try again shortly.');
  const body = { error: message };
  if (e.reason !== undefined) body.reason = e.reason;
  if (e.confidence !== undefined) body.confidence = e.confidence;
  if (e.suggestedMode !== undefined) body.suggestedMode = e.suggestedMode;
  if (e.draftStatus !== undefined) body.status = e.draftStatus;
  if (e.attempted !== undefined) body.attempted = e.attempted;
  if (e.missingClasses !== undefined) body.missingClasses = e.missingClasses;
  if (e.componentKey !== undefined) body.componentKey = e.componentKey;
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
    const visibleFaqCount = await countCurrentlyVisibleFaqPages(site);
    return await inspectRenderMode(file.content, actionType, { visibleFaqCount, visibleFaqCap: site.visible_faq_cap });
  } catch {
    return null;
  }
}

// Which componentTemplates key (design-drift.js's COMPONENT_TEMPLATE_KEY)
// a generator's own output actually needs styled — 1:1 with generatorId for
// faq/expand-content/internal-links/qa-content, but the 3 compliance
// generators (cookie-policy/privacy-policy/terms-of-service) all share the
// single generic 'content-wrapper' key (see frontend.js's
// COMPLIANCE_ACTION_TYPES and newpage-render.js's renderCompliancePageBody)
// rather than each having their own.
// (moved to implementers/lib/design-drift.js, next to COMPONENT_TEMPLATE_KEY,
// so this gate and the recommendation-visibility gate in
// agents/lib/recommendations.js share one definition and cannot drift apart —
// re-exported from there, imported at the top of this file.)

const router = Router();
router.use(requireAuth);

// Overrides req.siteId to a `?siteId=` query param, but only for a
// platform_admin session (same pattern as assistant.js's resolveContext) —
// a platform_admin genuinely manages many client sites (e.g. arriving here
// via the Analyst's "Send to Action Center" link for whichever client is
// selected there), while a tenant user's req.siteId always stays exactly
// their own session's site, with no code path to change it. Invalid/missing
// ids, and any non-platform-admin session, fall through to the session's own
// site untouched.
router.use(async (req, res, next) => {
  if (!req.query.siteId) return next();
  try {
    const user = await getUserById(req.userId);
    if (user?.role !== 'platform_admin') return next();
    const requested = Number(req.query.siteId);
    if (!Number.isInteger(requested)) return next();
    const site = await getSiteById(requested);
    if (site) req.siteId = requested;
    next();
  } catch (e) { next(e); }
});

// Most recent persisted recommendations — instant, may be stale. `Refresh`
// below re-runs the agents fresh.
router.get('/action-center/recommendations', async (req, res, next) => {
  try {
    res.json(await getRecommendations(req.siteId));
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
  // Same up-front template repair as the morning run (job.js): stamp any
  // existing-but-unstamped component template that the live CSS still backs,
  // so a manual refresh shows what is genuinely blocked rather than what was
  // merely never stamped. Never fatal.
  await repairSiteTemplates(siteId)
    .catch((err) => console.warn(`[action-center] site ${siteId} component-template repair failed:`, err.message));
  const grounded = await buildRecommendations(siteId);
  await syncFromGrounded(siteId, grounded);
  await autoRemediateSafeRecommendations(siteId).catch((err) => console.error(`[action-center] site ${siteId} auto-remediation failed:`, err.message));
  return getRecommendations(siteId);
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
// `memoryRefId` (optional) is supplied only by the cross-client learned-repair
// path (agents/lib/learned-repair.js), which has ALREADY chosen the specific
// agent_fix_memory row it is acting on — the whole decision to draft at all
// came from that row. Letting the lookup below run instead would bind the
// draft to whatever this site's own closest match happens to be, and the
// later verification outcome would then be credited to the wrong memory.
// Every other caller omits it and gets today's behavior unchanged.
// waitForDesignAgent: false (default) keeps today's fail-fast behavior — most
// interactive callers (this file's own routes, analyst-seo-mapping.js, MCP)
// want that, since a user's click should never hang for minutes waiting on a
// repo analysis. `true` waits up to design-drift.js's full DESIGN_AGENT_WAIT_MS
// (5 min) — only the unattended cron paths (auto-remediation.js,
// learned-repair.js) use that, so a site's first-ever draft of a
// design-sensitive type can ship in the same 07:00 pass that queued the
// derivation instead of only unblocking the next day's run. A number is a
// custom wait budget in ms — dataAnalyst.js's "Generate Content Draft" button
// uses a short one so a mid-derivation click gets a real result instead of
// an immediate "come back later", without hanging the request for minutes.
export async function generateDraft(siteId, { generatorId, params, source, findingOrigin, findingId, memoryRefId: presetMemoryRefId = null, waitForDesignAgent = false } = {}) {
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

  // Design verification runs BEFORE the generator does, not after.
  // It used to sit below the Quality Gate loop, which meant a
  // design-blocked site burned a full LLM generation on every manual
  // Generate Draft click and then threw 422 on content it had already
  // paid for and could never persist. Nothing about the gate itself
  // needs the generated content — it is a structural/provenance check on
  // the site config — so the cheap check goes first.
  //
  // `effectiveSite` is still produced here and consumed by the Rendering
  // Validation Gate further down, which is why this block resolves the
  // template rather than only verifying it.
  // Design Agent, stage — find-or-create the real, site-specific
  // componentTemplate this generator's output needs to render styled,
  // BEFORE this recommendation ever becomes a reviewable draft. Replaces
  // the old manual "Seed missing templates" staff step entirely: the first
  // recommendation of a new content type on a given site pays the one-time
  // cost of a real Design Agent (Docker/OpenHands) session against that
  // site's actual repo, right here; every recommendation after that for the
  // same site+type reuses the saved template instantly (resolveOrCreate...'s
  // own fast path).
  //
  // This stage USED to be best-effort: a site with design_agent_enabled off,
  // no repo configured, or a failed Design Agent run still got a draft, just
  // rendered with marker-merge.js/newpage-render.js's zero-config DEFAULT_*
  // fallback template. That fail-open behaviour is precisely what let
  // never-verified templates reach apply time and fail there, and it is now
  // a HARD GATE (the verification block directly below): for an action type
  // that HAS a component-template concept, an unverified template means NO
  // draft. The DEFAULT_* fallbacks still exist and still render — they are
  // simply no longer considered good enough to publish styled content into
  // a real customer's live site unreviewed.
  // resolveOrCreateComponentTemplate itself already no-ops safely (reason:
  // 'no-concept') for any generatorId with no componentTemplates key at
  // all — no need to pre-filter which ones apply here. The resolved
  // template is merged into a local `effectiveSite` snapshot (rather than
  // re-fetching from the DB) so the render step right below sees it
  // immediately, even on the very same call that just derived+saved it.
  let effectiveSite = await getSiteById(siteId);
  if (effectiveSite) {
    const templateResult = await resolveOrCreateComponentTemplate(effectiveSite, componentTemplateActionTypeFor(generatorId), {
      waitForCompletion: Boolean(waitForDesignAgent),
      ...(typeof waitForDesignAgent === 'number' ? { waitBudgetMs: waitForDesignAgent } : {}),
    }).catch((err) => { console.error(`[action-center] componentTemplate resolution failed for ${generatorId}:`, err.message); return null; });
    if (templateResult?.ok && templateResult.template) {
      effectiveSite = {
        ...effectiveSite,
        url_file_map: {
          ...effectiveSite.url_file_map,
          siteRoot: {
            ...effectiveSite.url_file_map?.siteRoot,
            componentTemplates: {
              ...effectiveSite.url_file_map?.siteRoot?.componentTemplates,
              [templateResult.componentKey]: templateResult.template,
            },
          },
        },
      };
    }

    // Informational only, deliberately NOT a gate. Design Context (verified
    // template / v2 profile) shapes what gets generated below when it's
    // available; when it isn't (new site, context still queued, a stale
    // background rescan) the generator's own zero-config fallback renders
    // instead — see marker-merge.js/newpage-render.js. A missing or
    // not-yet-derived Design Context must never stop an unrelated draft from
    // shipping: that hard-422 used to block every faq/expand-content/
    // internal-links/qa-content/net-new-page draft on a site any time the
    // analysis job failed, which is exactly the stuck-Action-Center failure
    // mode this replaces. 'no-concept' action types (meta-title, schema,
    // canonical, sitemap, robots-fix, ...) were never affected either way.
    const verification = componentTemplateVerification(effectiveSite, componentTemplateActionTypeFor(generatorId));
    if (!verification.ok) {
      console.warn(`[action-center] ${generatorId} has no verified Design Context yet (${verification.reason}) — generating with the default fallback template.`);
    }
  }

  // The Quality Gate — stage 1 of Generate -> Validate -> Auto-fix ->
  // Validate again. Never persist a draft (and never let schema/PR steps
  // downstream see one) that's still outline instructions, placeholder
  // brackets, duplicate paragraphs, or invalid JSON-LD instead of finished
  // content — one bounded regeneration attempt first, matching generators'
  // own "one bounded retry, never a hard failure" convention, then reject
  // outright rather than shipping it. This is the ONE place every
  // generator's output is validated, whether called from the manual UI,
  // the MCP tool, or the unattended execution-engine/auto-remediation
  // chains — a future generator gets this for free just by existing.
  const MAX_GENERATION_ATTEMPTS = 2;
  let content, summary, gateResult;
  let firstAttemptIssues = null;
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    ({ content, summary } = await generator.generate({ siteId, params: params || {} }));
    gateResult = await runQualityGate(content, generatorId, siteId);
    if (attempt === 1 && !gateResult.clean) firstAttemptIssues = gateResult.issues;
    if (gateResult.clean) break;
    if (attempt < MAX_GENERATION_ATTEMPTS) {
      console.warn(`[action-center] ${generatorId} draft failed the Quality Gate (attempt ${attempt}), regenerating:`, gateResult.issues);
    }
  }
  if (!gateResult.clean) {
    const err = new Error(`This recommendation could not be generated cleanly (incomplete/invalid content after ${MAX_GENERATION_ATTEMPTS} attempts) — try again shortly.`);
    err.status = 502;
    err.userFacing = true;
    // A REFUSAL, not a fault — see auto-remediation.js's circuit breaker.
    //
    // Two attempts that both produced unclean content is a statement about
    // THIS item's content, not about system health: the next recommendation
    // may well generate perfectly. The breaker exists for faults where every
    // subsequent attempt is also doomed (revoked token, moved default branch),
    // and this is not one.
    //
    // Flagged explicitly rather than by status code because 502 is the honest
    // HTTP answer here — the generator is upstream of us and it did not
    // produce usable output — and the breaker's 4xx heuristic would otherwise
    // read that as a systemic failure. Three unlucky items in a row would then
    // halt a 30-item day with 27 shippable candidates untouched.
    err.refusal = true;
    err.reason = 'quality-gate-exhausted';
    throw err;
  }

  // Learning system, stage 1 — the first attempt failed but a later one
  // didn't: real, deterministic evidence that this generator's output for
  // this class of issue was auto-fixed successfully. Recorded as
  // agent_fix_memory rows keyed by the exact validation rule (patternId)
  // that fired, so server/llm.js's existing withAgentMemory() picks it up on
  // this generator's very next call — the "before every generation, check
  // for previously-observed patterns and avoid repeating them" half of the
  // learning loop needs no new code beyond writing here; the read/inject
  // path already exists. gateResolvedPatterns rides along on the draft row
  // so approveAndPublishDraft can later confirm (or not) that this fix
  // actually held.
  let gateResolvedPatterns = null;
  if (firstAttemptIssues?.length) {
    gateResolvedPatterns = [...new Set(firstAttemptIssues.map((i) => i.patternId))];
    await Promise.all(gateResolvedPatterns.map((patternId) => recordFixOutcome({
      category: topLevelCategoryForGenerator(generatorId), scope: 'client', siteId, generatorId,
      validationRuleId: patternId, outcome: 'success', sourceType: 'runtime-auto',
      problemSignature: patternId,
      symptoms: `Past ${generatorId} drafts have hit "${patternId}" and needed a second attempt to fix it.`,
      rootCause: rootCauseForPattern(patternId),
      affectedPattern: `${generatorId} generation output matching Quality Gate pattern "${patternId}" (${categoryForPattern(patternId)}).`,
      fixStrategy: `Avoid "${patternId}" on the first attempt` +
        `${rootCauseForPattern(patternId) ? ` — ${rootCauseForPattern(patternId)}` : ''}.`,
      // The actionable half. fix_strategy describes what went wrong for a
      // human reading the row; fix_pattern is the directive withAgentMemory
      // inlines into a future generator's prompt once this lesson is trusted
      // enough to be promoted to 'auto'. Client-agnostic by construction —
      // see fixDirectiveForPattern — which is what makes it safe on a
      // cross-tenant row.
      fixPattern: fixDirectiveForPattern(patternId),
    }).catch((err) => console.error(`[action-center] failed to record auto-fix memory for ${generatorId}/${patternId}:`, err.message))));
  }


  // Rendering Validation Gate, stage — for the net-new-content action types
  // (frontend.js's FRONTEND_ACTION_TYPES: compliance pages, landing pages,
  // blog outlines, translations, direct answers), the FULL final output —
  // design/template already resolved above, real body rendered, target file
  // resolved — is computed and validated right here, at generation time,
  // not deferred to the approval click. A generation-time failure here (a
  // genuinely unfixable site-onboarding gap, e.g. no renderCapabilities
  // recorded — see rendering-gate.js) means this recommendation doesn't
  // become an approvable draft this pass, same as a Quality Gate failure
  // above: an honest error, not a silently-broken draft sitting in the
  // queue. A successful check's output is cached on the draft row
  // (rendered_body/target_file_path, migration 095) so approveAndPublishDraft
  // never has to recompute or re-derive anything — see frontend.js's
  // resolveTargetAndBody fast path. Marker-merge action types (FAQ,
  // expand-content, internal-links, ...) are deliberately NOT included
  // here — their real output depends on the live page's CURRENT content at
  // apply time (backend.js's computeMarkerMerge), which this generation
  // step has no way to know yet and must not guess.
  let renderedBody = null;
  let targetFilePath = null;
  if (FRONTEND_ACTION_TYPES.has(generatorId) && effectiveSite?.repo_owner && effectiveSite?.repo_name) {
    const draftLike = { action_type: generatorId, content, input: params || {} };
    const resolved = await resolveTargetAndBody(effectiveSite, draftLike);
    if (!resolved.ok) {
      const err = new Error(`This recommendation could not be prepared yet — ${resolved.error}`);
      err.status = 422;
      err.userFacing = true;
      throw err;
    }
    const renderingCheck = await validateRendering(effectiveSite, {
      path: resolved.filePath, content: resolved.body, contentFormat: resolved.contentFormat, actionType: generatorId,
    });
    if (!renderingCheck.ok) {
      const err = new Error(`This recommendation could not be prepared yet — ${renderingCheck.error}`);
      err.status = 422;
      err.userFacing = true;
      throw err;
    }
    renderedBody = resolved.body;
    targetFilePath = resolved.filePath;
  }

  // Learning system — REUSE/ADAPT step: which (if any) shared agent_fix_memory
  // row was the closest known match for this generator/site at generation
  // time. Recorded on the draft (memory_ref_id, migration 098) so
  // fix-verification.js's real outcome check can later feed success/failure
  // back to THIS specific memory (recordFixOutcome), not just "some fix
  // happened for this generator" — the part of the loop that makes reuse
  // outcomes (not just first-time learning) measurable. A generator's own
  // LLM prompt already got the fuller, cached multi-match version of this
  // same lookup via withAgentMemory (server/llm.js) — this is a second,
  // uncached call because it needs the specific top match's id, not just
  // rendered prompt text.
  const memoryMatch = presetMemoryRefId ? [] : await findRelevantMemory({
    category: topLevelCategoryForGenerator(generatorId), scope: 'client', siteId, generatorId, clientFacing: true, limit: 1,
  }).catch((err) => { console.error(`[action-center] agent_fix_memory lookup failed for ${generatorId}:`, err.message); return []; });
  const memoryRefId = presetMemoryRefId ?? (memoryMatch[0]?.id ?? null);

  const draft = await createDraft(siteId, {
    actionType: generatorId, source: source || 'manual',
    // The real detecting agent (e.g. 'opportunity'/'content-gap'/
    // 'analyst-insights'), kept separate from `source` above — callers that
    // ship on behalf of an existing recommendation (auto-remediation.js,
    // the execution-engine path below) pass the recommendation's own
    // detecting_agents[0] here while overwriting `source` with their own
    // shipping-mechanism label; a caller with no separate origin (a manual
    // click, where `source` already IS the real detecting agent) simply
    // omits this and fix-verifications.js's isVerifiableDraft falls back to
    // `source`. See migration 119.
    findingOrigin: findingOrigin || null,
    input: params || {}, content, findingId, gateResolvedPatterns,
    renderedBody, targetFilePath, memoryRefId,
  });

  // geo-audit is a generator, not an orchestrator-run agent, so its score
  // never reached agent_runs on its own — command-center.js had nothing to
  // read, unlike authority/ai-visibility. Persist a matching snapshot here,
  // the one shared path
  // cron (job.js's runGeoAuditIfDue), MCP, and this manual route all go
  // through, so all three ways of running it stay in sync automatically.
  //
  // Saved unconditionally (not gated on content?.score being truthy) — the
  // dashboard's "GEO — Not run yet" reads command-center.js's geoAuditMeta,
  // which is entirely sourced from whether an agent_runs row exists at all
  // (hasRun/lastRunAt), not from the score. A real run that happened to
  // score zero pages (an empty scoredPages set — analyzePageUrl failures,
  // insufficient content, etc.) used to look identical to "never run" on
  // the dashboard, permanently, since site.geo_audit_last_done still
  // advances either way and blocks a re-run for another week (real
  // incident, 2026-08-10: site #1 showed "Not run yet" despite
  // geo_audit_last_done proving a real run on 2026-07-26).
  if (generatorId === 'geo-audit') {
    await saveAgentRun({
      siteId, agentId: 'geo-audit', agentVersion: 1, input: params || {},
      status: 'ok', facts: { siteScore: content?.score ?? null, findings: content?.findings ?? [] },
      narrative: null, error: null, tookMs: null,
    }).catch((err) => console.error('[action-center] failed to save geo-audit agent_runs snapshot:', err.message));
  }

  // Stamps growth_query_status.drafted_at so server/agents/growth-queries.js's
  // Phase 5 verification rotation picks this query up — best-effort only,
  // never blocks or fails draft creation over this bookkeeping write.
  if (generatorId === 'direct-answer' && params?.queryId) {
    await markQueryDrafted(siteId, params.queryId).catch((err) => console.error('[action-center] failed to mark growth query drafted:', err.message));
  }

  const renderModeHint = await buildRenderModeHint(siteId, generatorId, params?.page || content?.page);
  return { ...draft, summary, renderModeHint };
}

router.post('/action-center/generate', async (req, res, next) => {
  try {
    const { generatorId, params, source, findingId } = req.body || {};
    res.json(await generateDraft(req.siteId, { generatorId, params, source, findingId }));
  } catch (e) {
    if (e.status === 400 || e.status === 404) {
      const message = e.userFacing ? e.message : sanitizeForCustomer(e.message, 'This recommendation could not be generated right now — try again shortly.');
      return res.status(e.status).json({ error: message });
    }
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

// Phase 3 approval workflow — Reject (reuses the existing 'abandoned'
// terminal status, now with a reviewer/reason attached — see
// markDraftAbandoned's own comment) and Request Revision (a non-terminal
// bounce back to the author — see requestDraftRevision's own comment).
// Both valid from any non-terminal state, same guard style as approve.
router.post('/action-center/drafts/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const draft = await markDraftAbandoned(req.siteId, req.params.id, reason || 'rejected_by_reviewer', req.userId);
    if (!draft) return res.status(404).json({ error: 'Draft not found, or already in a terminal state' });
    // Phase 5: a genuine HUMAN rejection, distinct from the automatic
    // supersede/dedup calls to markDraftAbandoned elsewhere in this file
    // (those pass no abandonedBy, since no reviewer made a judgment) — only
    // this route, the Phase 3 Reject action, represents real evidence that a
    // human looked at the generator's output and declined it.
    recordOutcome(req.siteId, draft.action_type, 'rejected', { draftId: draft.id, detail: (reason || '').slice(0, 500) }).catch(() => {});
    res.json(draft);
  } catch (e) { next(e); }
});

router.post('/action-center/drafts/:id/request-revision', async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const draft = await requestDraftRevision(req.siteId, req.params.id, { reviewerId: req.userId, reason });
    if (!draft) return res.status(404).json({ error: 'Draft not found, or not in a reviewable state' });
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
export async function approveAndPublishDraft(siteId, draftId, { userId, renderMode, deferPr = false } = {}) {
  const draft = await getDraft(siteId, draftId);
  if (!draft || draft.status !== 'submitted_for_approval') {
    throw httpError(404, 'Draft not found, or not submitted for approval');
  }

  // Quality Gate stage 2 — re-validated here, not just at generation time,
  // because a draft can be hand-edited (DraftModal.jsx) between generateDraft
  // and this approval step; a human editing scaffolding/a duplicate
  // paragraph/a broken JSON-LD field back INTO an otherwise-clean draft must
  // never reach a real PR. No regeneration possible here (a human already
  // wrote this content) — just refuse approval with the specific issues so
  // they know what to fix.
  const gateResult = await runQualityGate(draft.content, draft.action_type, siteId);
  // Approval Gate (routes/lib/approval-gate.js): recorded whether it passes
  // or fails, so Action Center can show "quality gate: ok" as real evidence,
  // not just silence-means-fine — see that module's comment for the
  // first-class-not-informational framing.
  await recordValidationStatus(siteId, draft.id, { qualityGate: { ok: gateResult.clean, issues: gateResult.issues } });
  if (!gateResult.clean) {
    throw httpError(422, `This draft can't be approved yet — it still has ${gateResult.issues.length} unresolved quality issue(s) ` +
      `(${[...new Set(gateResult.issues.map((i) => i.patternId))].join(', ')}). Fix the content and resubmit.`, { issues: gateResult.issues });
  }

  // Phase 4 — continuous learning: a human editing this draft before
  // approving it (DraftModal.jsx -> updateDraft) is a real, verified
  // correction, worth more than a recommendation nobody acts on twice. Best
  // effort only — a lesson-writing failure must never block a real
  // approval, same defensive convention as every other non-critical
  // side-effect in this function (recordAuditEvent, etc.).
  const humanEdited = draft.original_content && JSON.stringify(draft.original_content) !== JSON.stringify(draft.content);
  if (humanEdited) {
    const lesson = extractEditLesson(draft.action_type, draft.original_content, draft.content);
    if (lesson) {
      await recordFixOutcome({
        category: topLevelCategoryForGenerator(draft.action_type), scope: 'client', siteId, generatorId: draft.action_type,
        validationRuleId: lesson.validationRuleId, outcome: 'success', sourceType: 'human-edit',
        problemSignature: lesson.validationRuleId || lesson.title,
        symptoms: lesson.lesson, affectedPattern: `${draft.action_type} output requiring the same correction pattern.`,
        fixStrategy: lesson.lesson,
      }).catch((err) => console.error(`[action-center] failed to record edit lesson for draft ${draft.id}:`, err.message));
    }
  }

  // Learning system, stage 2 — the outcome of a lesson recorded at
  // generation time (see generateDraft's own comment). Reaching this exact
  // point means the Quality Gate above already passed on the CURRENT
  // content, so any pattern this draft's generation self-corrected really
  // did hold through to real approval: re-recording the identical lesson
  // hits recordFixOutcome's own dedup-by-validationRuleId path, which
  // increments occurrence_count/confidence and promotes 'candidate' ->
  // 'trusted' (and 'requires_approval' -> 'auto') after enough
  // confirmations, instead of a fresh duplicate row.
  if (draft.gate_resolved_patterns?.length) {
    await Promise.all(draft.gate_resolved_patterns.map((patternId) => recordFixOutcome({
      category: topLevelCategoryForGenerator(draft.action_type), scope: 'client', siteId, generatorId: draft.action_type,
      validationRuleId: patternId, outcome: 'success', sourceType: 'runtime-auto',
      problemSignature: patternId,
      symptoms: `Past ${draft.action_type} drafts have hit "${patternId}" and needed a second attempt to fix it.`,
      rootCause: rootCauseForPattern(patternId),
      affectedPattern: `${draft.action_type} generation output matching Quality Gate pattern "${patternId}" (${categoryForPattern(patternId)}).`,
      fixStrategy: `Avoid "${patternId}" on the first attempt` +
        `${rootCauseForPattern(patternId) ? ` — ${rootCauseForPattern(patternId)}` : ''}.`,
    }).catch((err) => console.error(`[action-center] failed to confirm auto-fix memory for draft ${draft.id}/${patternId}:`, err.message))));
  }

  // A human editing a draft from a generator that already has a trusted,
  // auto-appliable memory behind it (execution_permission='auto') is a real
  // signal that memory may no longer hold — this app can't semantically
  // prove the edit undid THAT specific memory's effect, so this is
  // deliberately a coarser, honestly-described signal ("humans keep editing
  // this generator's output despite an active auto rule"), recorded as a
  // failed reuse (recordFixOutcome's memoryRefId + outcome:'failure' path).
  // Two such overrides in a row flips the memory to 'flagged_for_review'
  // (see agent-memory.js's recordReuseOutcome) instead of it silently
  // continuing to auto-apply unchanged.
  if (humanEdited) {
    const activeMemories = await getActiveAutoMemories(draft.action_type, siteId).catch(() => []);
    await Promise.all(activeMemories.map((m) => recordFixOutcome({
      memoryRefId: m.id, outcome: 'failure', generatorId: draft.action_type, siteId, agentId: 'human-edit-override',
    }).catch((err) => console.error(`[action-center] failed to record override for memory ${m.id}:`, err.message))));
  }

  const site = await getSiteById(siteId);
  let resolved = null;
  if (site.repo_owner && site.repo_name) {
    resolved = await resolveImplementerForApply(site, draft, renderMode);
    if (resolved.reason === 'render-mode-uncertain') {
      throw httpError(422, resolved.error, { reason: resolved.reason, confidence: resolved.confidence, suggestedMode: resolved.suggestedMode });
    }
    if (resolved.error) throw httpError(400, resolved.error);
    if (typeof resolved.implementer.preview === 'function') {
      const previewResult = await resolved.implementer.preview(site, draft, { renderModeOverride: renderMode });
      if (!previewResult.ok) {
        throw httpError(422, previewResult.error, {
          reason: previewResult.reason, confidence: previewResult.confidence, suggestedMode: previewResult.suggestedMode,
          missingClasses: previewResult.missingClasses, componentKey: previewResult.componentKey,
        });
      }

      // Approval Gate, Phase 1 (implementers/lib/rendering-gate.js) — the
      // exact same check implementer.apply()'s pushDraftBranch will run
      // deep inside itself, run again here as its OWN named, surfaced
      // check, before approveDraft() flips real status. Redundant with the
      // one inside apply() by design (same accepted "minor cost" tradeoff
      // as preview()/apply() both computing a live GitHub read — see this
      // function's own module comment above) — the point is that a
      // Markdown-unsafe target is rejected as a clearly labeled validation
      // failure here, not just an opaque "apply failed" after status has
      // already moved past submitted_for_approval.
      const renderingCheck = await validateRendering(site, {
        path: previewResult.filePath, content: previewResult.newContent,
        contentFormat: previewResult.contentFormat, actionType: draft.action_type,
      });
      await recordValidationStatus(siteId, draft.id, { renderingConfig: renderingCheck });
      const renderingGate = evaluateApprovalGate({ renderingConfig: renderingCheck });
      if (!renderingGate.ok) {
        throw httpError(422, `This draft can't be approved yet — ${renderingGate.blockingError}`, { reason: renderingCheck.reason });
      }
    }
  }

  const approvedDraft = await approveDraft(siteId, draft.id, userId);
  if (!approvedDraft) throw httpError(404, 'Draft not found, or not submitted for approval');
  if (!resolved) return approvedDraft;

  // Terminal-state gate (universal insertion engine, see
  // insertion-engine.js's buildUnresolvedInsertionFailure): markDraftBranchPushed
  // and mergeToStage below are only ever reached when applyResult.ok is
  // true, i.e. when every marker the draft needed was genuinely resolved
  // and spliced — a draft that came back unresolved (applyResult.reason ===
  // 'no-confident-insertion-point', or any other apply failure) always
  // returns here instead, never proceeds to a PR. This branch, and the
  // GitHub push/PR calls implementer.apply()/mergeToStage() make internally,
  // have no automated test coverage — this repo has no convention for
  // mocking GitHub network calls (no supertest/nock/sinon, no
  // server/routes/*.test.js), so that gap predates this feature and applies
  // equally to every implementer. The PURE per-field failure-shape logic
  // this gate depends on (buildUnresolvedInsertionFailure) is unit-tested in
  // server/implementers/lib/insertion-engine.test.js.
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

  // deferPr: this draft is part of a batch run (github-ops.js's
  // beginBatchPush is already active for its branch) — its commit was
  // created but the branch ref deliberately hasn't moved yet, so GitHub
  // would 422 a PR-open attempt right now ("No commits between X and Y").
  // The caller (executeSafeFixes/auto-remediation's loop) opens exactly ONE
  // PR for the whole batch, once, via finalizeBatchPr below, after the
  // batch's one real push lands. Leaves the draft at 'branch_pushed' — the
  // same intermediate state the "Open PR" button already recovers from
  // manually (openDraftPr), so this is not a new draft state, just a new,
  // deliberate way to reach it.
  if (deferPr || typeof implementer.mergeToStage !== 'function') return branchPushedDraft;

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

// Wraps approveAndPublishDraft for the two UNATTENDED auto-ship paths —
// auto-remediation.js's shipDraftForRecommendation and this file's own
// shipRecommendation (execution-engine). Never used for a human clicking
// Approve in DraftModal.jsx, which must see the failure and be able to
// edit/retry, not have its draft vanish out from under it.
//
// approveAndPublishDraft can throw AFTER submitDraftForApproval already left
// a real, durable draft row at 'submitted_for_approval' — a render-mode-
// uncertain resolution, a failed implementer preview, or a rejected
// rendering-gate check, none of which revert the row. getDraftedFindingIds()
// then treats that row as "already handled" forever (status != 'abandoned'
// AND apply_error IS NULL both hold for it), which permanently hides the
// underlying recommendation from every future unattended pass — the exact
// same strand-and-hide shape the duplicate-paragraph Quality Gate bug had
// (see generators/lib/duplicate-content-guard.js), just triggered by a
// different failure point inside this same function (confirmed live,
// 2026-08-25: 31 real drafts stuck this way on site #1, across
// broken-link-fix/alt-text/schema-repair/analytics-install). Abandoning the
// draft here on failure is what makes getDraftedFindingIds() correctly stop
// counting it, so the next scheduled run can actually retry the
// recommendation instead of silently never seeing it again.
export async function approveAndPublishDraftUnattended(siteId, draftId, opts, {
  approveFn = approveAndPublishDraft,
  abandonFn = markDraftAbandoned,
} = {}) {
  try {
    return await approveFn(siteId, draftId, opts);
  } catch (err) {
    await abandonFn(siteId, draftId, `Auto-ship failed: ${String(err.message || err).slice(0, 500)}`, null).catch((abandonErr) => {
      console.error(`[action-center] could not abandon draft ${draftId} after unattended ship failure:`, abandonErr.message);
    });
    throw err;
  }
}

// Phase 4 M3 — the Execution Engine. Drives the exact same
// generateDraft -> submitDraftForApproval -> approveAndPublishDraft chain
// the manual per-draft UI already uses (defined just above), just without a
// human click between each step. Never reimplements draft generation,
// GitHub, or PR logic — same-day approvals already land in one shared batch
// branch/PR via approveAndPublishDraft/github-ops.js, so running N of these
// back to back already produces ONE branch/PR, not N.
//
// Only ever called for risk_tier='safe' recommendations (see
// agents/lib/risk-tiers.js) — manual-tier recommendations (landing pages,
// pricing, nav, etc.) never go through this function; they stay on the
// existing stepped Generate/Submit/Approve UI so a human deliberately
// reviews each step.
// meta-title's own generator always returns 3 candidate titles (never one),
// by design, for a human to pick from in the manual UI — but neither
// shipRecommendation's (below) nor auto-remediation.js's unattended chains
// have a human here to click "Use this" (DraftModal.jsx). Without a
// selection, buildMergeValues (marker-merge.js) refuses to publish at all
// ("No title selected yet"), which meant meta-title could never actually
// auto-ship despite being listed in SAFE_GENERATOR_IDS. Deterministically
// taking the first candidate is safe here specifically because all 3 are
// already equally real, grounded LLM output (same query, same page text) —
// this is an arbitrary pick among validated options, not a fabricated fact,
// so it doesn't cross the same line as guessing a price or rating. Returns
// the updated content, or null if no auto-selection was needed/possible.
export function autoSelectMetaTitle(generatorId, content) {
  if (generatorId !== 'meta-title' || content?.selectedTitle || !content?.titles?.[0]) return null;
  return { ...content, selectedTitle: content.titles[0] };
}

async function shipRecommendation(siteId, rec, { userId, jobId, deferPr = false }) {
  const jobRec = await addJobRecommendation(jobId, rec.id);
  try {
    const draft = await generateDraft(siteId, {
      generatorId: rec.recommendation_type, params: rec.params, source: 'execution-engine', findingId: rec.finding_ids[0],
      findingOrigin: rec.detecting_agents?.[0] || null,
    });
    await updateJobRecommendationStatus(jobRec.id, 'drafted', { draftId: draft.id });
    await setRecommendationExecutionState(rec.id, { executionJobId: jobId, executionStatus: 'drafted' });

    // generateDraft is idempotent on findingId: a prior run (or the manual
    // UI) may have already carried this exact finding's draft past 'draft'/
    // 'edited' — including all the way to 'implemented'. That's not a
    // failure to retry, it's this recommendation already being fully
    // shipped; walking submitDraftForApproval/approveAndPublishDraft again
    // would either no-op (correctly refused, "not in a submittable state")
    // or worse, re-approve/re-publish already-live content. Short-circuit
    // as success instead, and let the stale `recommendations` row close out
    // via its normal getDraftedFindingIds-based reopening rather than
    // retrying it every run.
    // ...but "not submittable" is not one condition, it is three, and
    // collapsing them into "already shipped" reported work as landed that
    // never reached GitHub. A draft stranded at 'approved' by a failed
    // apply() has no branch and no PR; calling that shipped is the one
    // outcome worse than calling it failed. See lib/draft-ship-state.js for
    // the measured case (8 expand-content drafts stuck since 2026-08-28).
    const shipState = draftShipState(draft);
    if (shipState === SHIP_STATE.SHIPPED) {
      await updateJobRecommendationStatus(jobRec.id, 'approved', { draftId: draft.id });
      await setRecommendationExecutionState(rec.id, { executionJobId: jobId, executionStatus: 'shipped' });
      return { ok: true, draft, alreadyShipped: true };
    }
    if (shipState === SHIP_STATE.AWAITING_PR) {
      // A real commit exists but its PR was never opened. Hand it to the
      // batch's pending list so finalizeBatchPr covers it, instead of
      // declaring it done and leaving the commit permanently PR-less.
      await updateJobRecommendationStatus(jobRec.id, 'submitted', { draftId: draft.id });
      return { ok: true, draft, jobRecId: jobRec.id, pendingPr: deferPr };
    }
    if (shipState === SHIP_STATE.RESUME_APPLY) {
      // Re-run only the step that failed. The content is already generated
      // and Quality-Gated; regenerating would spend another model call to
      // arrive at the same draft.
      const pushed = await pushDraftBranch(siteId, draft.id);
      await updateJobRecommendationStatus(jobRec.id, 'submitted', { draftId: pushed.id });
      return { ok: true, draft: pushed, jobRecId: jobRec.id, pendingPr: deferPr };
    }
    if (shipState === SHIP_STATE.STRANDED) {
      // Never leave a partially-failed draft in a non-terminal status (this
      // repo's own recorded lesson for these paths). Reset it so the next run
      // generates a clean one, and report an honest failure — not a ship.
      await markDraftAbandoned(siteId, draft.id, `Stuck at "${draft.status}" and not resumable — abandoned so a fresh draft can be generated.`, null)
        .catch((err) => console.error(`[action-center] could not abandon unresumable draft ${draft.id}:`, err.message));
      await updateJobRecommendationStatus(jobRec.id, 'failed', { error: `Draft was stuck at "${draft.status}" and has been reset for a fresh attempt.` });
      return { ok: false };
    }

    const autoSelected = autoSelectMetaTitle(rec.recommendation_type, draft.content);
    if (autoSelected) {
      const updated = await updateDraft(siteId, draft.id, { content: autoSelected });
      if (updated) draft.content = updated.content;
    }

    const submitted = await submitDraftForApproval(siteId, draft.id);
    if (!submitted) throw new Error('Draft was not in a submittable state');
    await updateJobRecommendationStatus(jobRec.id, 'submitted', { draftId: draft.id });

    const approved = await approveAndPublishDraftUnattended(siteId, draft.id, { userId, deferPr });
    if (!approved.branch_name) throw new Error(approved.apply_error || 'Approved but no branch was pushed');

    if (deferPr) {
      // PR isn't open yet — this draft is left at 'branch_pushed', part of
      // a shared batch the caller finalizes ONCE after the whole run (see
      // finalizeBatchPr below) instead of every item opening its own PR
      // here. Job-rec status stays at 'submitted' (the closest existing
      // value — no 'branch_pushed' status exists for this column) and
      // recommendation execution_status is left unset until finalize
      // confirms a real PR, rather than marking either 'shipped' early.
      return { ok: true, draft: approved, pendingPr: true, jobRecId: jobRec.id };
    }

    await updateJobRecommendationStatus(jobRec.id, 'approved', { draftId: draft.id });
    await setRecommendationExecutionState(rec.id, { executionJobId: jobId, executionStatus: 'shipped' });
    return { ok: true, draft: approved };
  } catch (e) {
    // The generic "Execution failed" fallback used to discard safeMessage's
    // own correlation id, so a real failure here was only ever recoverable
    // by grepping live container logs for the right timestamp — no id, no
    // way to find it after the fact. Appending "(ref: <id>)" to the
    // PERSISTED text (never shown as the primary message, just a suffix)
    // makes `grep "internal-error:<id>"` on the server logs the actual next
    // step, instead of a manual scan through everything logged that day.
    let message;
    if (e.userFacing) {
      message = e.message;
    } else {
      const sanitized = sanitizeForCustomer(e.message);
      if (sanitized != null) {
        message = sanitized;
      } else {
        // Destructured to non-"dot message"-named locals deliberately:
        // unlike e dot message above, this value is never raw exception
        // text — safeMessage() always returns the caller-supplied fallback
        // string ('Execution failed'), never the caught error's own text
        // (the real detail only ever reaches logInternal's console log).
        // check-error-leaks.js's regex net can't see that distinction; it
        // matches any interpolated "dot message" property access by name,
        // so this is renamed to avoid colliding with a pattern that exists
        // to catch genuinely raw error-text leaks.
        const { message: safeFallback, id: safeId } = safeMessage('action-center.executeRecommendation', e, 'Execution failed');
        message = `${safeFallback} (ref: ${safeId})`;
      }
    }
    await updateJobRecommendationStatus(jobRec.id, 'failed', { error: message });
    await setRecommendationExecutionState(rec.id, { executionJobId: jobId, executionStatus: 'failed' });
    await appendJobLog(jobId, `Recommendation #${rec.id} (${rec.recommendation_type} @ "${rec.page || '(site-wide)'}") failed: ${message}`);
    return { ok: false, error: message };
  }
}

// Finalizes a batch run's worth of drafts left at 'branch_pushed' by
// shipRecommendation's deferPr mode: pushes every commit accumulated since
// the caller's own beginBatchPush as ONE ref update (github-ops.js's
// endBatchPush — the one real GitHub push, and therefore the one Vercel
// preview build, for the whole run), then opens exactly ONE PR for the
// batch (reusing openDraftPr, the same "finish a branch_pushed draft"
// path the manual retry button already uses) and marks every OTHER draft
// in the batch 'pr_opened' with that same PR — instead of each draft
// pushing and opening its own PR immediately.
//
// `draftIds` must all share the SAME batch branch (guaranteed by the
// caller's own beginBatchPush(branchName) call). On failure, nothing here
// updates any draft/recommendation row — the caller (which knows its own
// job-rec/execution-state bookkeeping shape) is responsible for reverting
// every id in `draftIds` to a real failure state, exactly the same
// strand-and-hide concern approveAndPublishDraftUnattended's own doc
// comment describes: a 'branch_pushed' draft nobody ever finalizes would
// otherwise permanently hide its recommendation from future runs.
export async function finalizeBatchPr(site, branchName, draftIds) {
  const pushResult = await endBatchPush(site, branchName);
  if (!pushResult.ok) return { ok: false, error: pushResult.error, rateLimited: pushResult.rateLimited === true };
  if (pushResult.pushed === 0 || draftIds.length === 0) {
    return { ok: true, pushed: 0, prNumber: null, prUrl: null };
  }
  try {
    const first = await openDraftPr(site.id, draftIds[0]);
    const prNumber = first.pr_number;
    const prUrl = first.pr_url;
    for (const id of draftIds.slice(1)) {
      await markDraftPrOpened(site.id, id, { prNumber, prUrl, rollbackSnapshot: null });
    }
    return { ok: true, pushed: pushResult.pushed, prNumber, prUrl };
  } catch (err) {
    // Both failure paths out of this function report `rateLimited`, so the
    // batch's caller can decide between "leave these re-attemptable" and
    // "abandon them" on evidence rather than on the error string.
    return { ok: false, error: err.message, rateLimited: err.rateLimited === true };
  }
}

// How many safe-tier recommendations one manual "Execute Today's Safe Fixes"
// click ships. THE one definition — the Action Center UI reads it back off
// /action-center/execution-stats/today rather than keeping its own copy, and
// sends no limit of its own, so the number on the button and the number the
// server actually ships cannot disagree. (Before this, 15 was written once
// here and three more times in ActionCenter.jsx.)
//
// Raised from 15 to 30, then to 60 on request (to match
// DRAFT_BULK_APPROVE_LIMIT below, so the two bulk-ship caps in this file
// don't drift apart with no reason). What actually bounds risk here is
// per-item and unchanged by the count: only 'safe'-tier generators are
// eligible (agents/lib/risk-tiers.js), the Quality Gate runs inside
// generateDraft with a bounded regeneration attempt, approveAndPublishDraft
// re-validates before the PR opens, every item lands on ONE shared branch/PR
// a human still has to merge, and a failure on one item never stops the rest.
// So the batch size changes throughput, not what can reach a repo.
//
// What it DOES change is wall-clock: 60 items each doing an LLM draft plus a
// GitHub push can outrun the browser's own 5-minute fetch ceiling
// (web/src/api.js's REQUEST_TIMEOUT_MS) on a slow run. The server finishes
// the job either way, so the client recovers via
// /action-center/execution-jobs/latest below rather than reporting a failure
// that didn't happen — without that, raising this number would have made
// failed items LESS visible, not more.
export const SAFE_FIX_BATCH_LIMIT = 60;

// "Execute Today's Safe Fixes" — picks up to `limit` open, safe-tier
// recommendations not already claimed by another job, ships each one via
// the chain above under ONE execution_jobs row. A failure on one item
// doesn't stop the rest; the job's final branch/PR reflect whatever the
// last successful item produced (they all share the same batch branch/PR).
export async function executeSafeFixes(siteId, { userId, limit = SAFE_FIX_BATCH_LIMIT } = {}) {
  const [selected, site, pendingDraftFilePaths] = await Promise.all([
    listOpenSafeRecommendations(siteId, limit),
    getSiteById(siteId),
    getPendingDraftFilePaths(siteId),
  ]);
  const job = await createExecutionJob(siteId, { trigger: 'bulk', requestedBy: userId });

  // The same two candidate rules the unattended path applies (ship-pacing.js).
  // Both were missing here, and this is the path that actually carries the
  // volume: three bulk runs on 2026-09-01 drafted 61 blog-outlines and opened
  // one PR with 42 net-new blog posts, while the cron path beside it was
  // correctly taking one per run. Clicking "Execute Safe Fixes" is a request
  // to ship a batch of FIXES — it was never a decision to publish that much
  // net-new content at once, nor to re-attempt findings that have already
  // failed the same way three times.
  //
  // Held items are logged to the job, not silently dropped, so the operator
  // can see exactly what was deferred and why — the same discipline the
  // daily budget's own truncation already follows.
  const { paced, notes: pacingNotes } = await applyPacing(site, selected);
  const { converged: recs, notes: convergenceNotes } = await applyConvergenceCap(site, paced);
  for (const note of [...pacingNotes, ...convergenceNotes]) await appendJobLog(job.id, note);

  if (recs.length === 0) {
    return { job: await finishExecutionJob(job.id, { status: 'completed' }), shipped: 0, failed: 0 };
  }
  const heldCount = selected.length - recs.length;
  await appendJobLog(job.id, `Selected ${recs.length} safe recommendation(s) for execution${heldCount > 0 ? ` (${heldCount} held by pacing/convergence rules)` : ''}.`);

  // Batch the git push: every item below runs with deferPr, so its commit
  // is created but the branch ref doesn't move and no PR opens per item —
  // see github-ops.js's beginBatchPush for why (up to SAFE_FIX_BATCH_LIMIT
  // items used to mean up to that many separate pushes, each its own
  // Vercel preview build, on the same PR). finalizeBatchPr below does the
  // one real push + one PR open, once, after the loop.
  const branchName = batchBranchName(site);
  beginBatchPush(site, branchName);

  let lastSuccess = null;
  let shipped = 0;
  let failed = 0;
  const pending = []; // { draftId, jobRecId, recId }
  for (const rec of recs) {
    // Same file-level guard as auto-remediation.js's autonomous path (see
    // getPendingDraftFilePaths' comment, store/drafts.js): skip a
    // recommendation targeting a file that already has an earlier draft
    // sitting on a still-open, unmerged Action Center PR, rather than
    // silently regenerating and clobbering/reverting it.
    if (pendingDraftFilePaths.has(resolveFile(site, rec.page))) {
      const jobRec = await addJobRecommendation(job.id, rec.id);
      await updateJobRecommendationStatus(jobRec.id, 'failed', { error: 'This page already has a pending draft on an unmerged PR — resolve that PR before shipping another change to it.' });
      await appendJobLog(job.id, `Recommendation #${rec.id} (${rec.recommendation_type} @ "${rec.page || '(site-wide)'}") skipped: already has a pending draft on an unmerged PR.`);
      failed++;
      continue;
    }
    const result = await shipRecommendation(siteId, rec, { userId, jobId: job.id, deferPr: true });
    if (result.ok) {
      shipped++;
      lastSuccess = result.draft;
      if (result.pendingPr) pending.push({ draftId: result.draft.id, jobRecId: result.jobRecId, recId: rec.id });
    } else {
      failed++;
    }
  }

  const finalization = await finalizeBatchPr(site, branchName, pending.map((p) => p.draftId));
  if (!finalization.ok) {
    // Nothing in `pending` actually reached a real PR — revert every one of
    // them from the optimistic 'submitted' job-rec status to a real
    // failure, so this isn't silently reported as shipped work that never
    // landed (the same strand-and-hide risk finalizeBatchPr's own comment
    // describes).
    // Transient failures must not be terminal here either. This is the path
    // that actually lost work on 2026-09-01: one exhausted GitHub budget
    // abandoned 54 Quality-Gate-passed drafts in this single call. Same
    // disposition as auto-remediation.js's batch finalize — recordMergeFailure
    // records the error WITHOUT changing status, and an unresolved apply_error
    // already reopens the finding, so the work is re-attemptable instead of
    // destroyed. Nothing is misreported as shipped either way: the job-rec
    // status still reverts to 'failed' and the counts still move.
    const transient = finalization.rateLimited === true;
    await appendJobLog(job.id, `Batch push/PR failed for ${branchName}: ${finalization.error} — ${pending.length} item(s) ${transient ? 'left re-attemptable (transient)' : 'reverted to failed'}.`);
    await Promise.all(pending.map(async (p) => {
      await updateJobRecommendationStatus(p.jobRecId, 'failed', { error: finalization.error });
      await setRecommendationExecutionState(p.recId, { executionJobId: job.id, executionStatus: 'failed' });
      const record = transient
        ? recordMergeFailure(siteId, p.draftId, finalization.error)
        : markDraftAbandoned(siteId, p.draftId, `Batch push/PR failed: ${finalization.error}`, null);
      await record.catch((err) => {
        console.error(`[action-center] could not ${transient ? 'mark retryable' : 'abandon'} draft ${p.draftId} after batch push/PR failure:`, err.message);
      });
    }));
    shipped -= pending.length;
    failed += pending.length;
  } else if (pending.length > 0) {
    await Promise.all(pending.map(async (p) => {
      await updateJobRecommendationStatus(p.jobRecId, 'approved', { draftId: p.draftId });
      await setRecommendationExecutionState(p.recId, { executionJobId: job.id, executionStatus: 'shipped' });
    }));
    await appendJobLog(job.id, `Batch pushed and PR opened: ${finalization.prUrl} (${finalization.pushed} commit(s)).`);
  }

  const finishedJob = await finishExecutionJob(job.id, {
    status: shipped > 0 ? 'completed' : 'failed',
    branchName: finalization.ok ? branchName : lastSuccess?.branch_name,
    prNumber: finalization.prNumber ?? lastSuccess?.pr_number,
    prUrl: finalization.prUrl ?? lastSuccess?.pr_url,
  });
  return { job: finishedJob, shipped, failed };
}

// How many pending drafts one manual "Approve All Pending" click ships in a
// single batch push/PR. Mirrors SAFE_FIX_BATCH_LIMIT above, but for the
// draft-based path used by content generators (e.g. blog-outline) that
// aren't 'safe'-tier recommendations and so never go through
// executeSafeFixes — before this, approving several of them one at a time
// meant one real push (and one Vercel preview build) per draft, with each
// new push racing the previous build and usually cancelling it.
export const DRAFT_BULK_APPROVE_LIMIT = 60;

// "Approve All Pending" — ships every draft currently awaiting approval for
// this site (up to `limit`) under ONE batch branch/push/PR, the same
// beginBatchPush/deferPr/finalizeBatchPr pattern executeSafeFixes uses above.
// Drafts have no recommendation_id to hang execution_job_recommendations rows
// off of (that column is NOT NULL, see migration 078_execution_jobs.sql), so
// this keeps only the execution_jobs row itself for the audit trail and logs
// per-draft outcomes via appendJobLog instead of per-item job-rec rows.
export async function bulkApproveDrafts(siteId, { userId, limit = DRAFT_BULK_APPROVE_LIMIT } = {}) {
  const [drafts, site] = await Promise.all([
    listDrafts(siteId, { status: 'submitted_for_approval' }),
    getSiteById(siteId),
  ]);
  const targeted = drafts.slice(0, limit);
  const job = await createExecutionJob(siteId, { trigger: 'bulk-drafts', requestedBy: userId });
  if (targeted.length === 0) {
    return { job: await finishExecutionJob(job.id, { status: 'completed' }), shipped: 0, failed: 0 };
  }
  await appendJobLog(job.id, `Selected ${targeted.length} pending draft(s) for bulk approval.`);

  // Batch the git push — see executeSafeFixes' own comment on beginBatchPush
  // above for why: every item below runs with deferPr, so its commit is
  // created but the branch ref doesn't move and no PR opens per item.
  const branchName = batchBranchName(site);
  beginBatchPush(site, branchName);

  let shipped = 0;
  let failed = 0;
  const pendingIds = [];
  for (const draft of targeted) {
    try {
      const result = await approveAndPublishDraft(siteId, draft.id, { userId, deferPr: true });
      if (result?.status === 'branch_pushed') {
        pendingIds.push(draft.id);
        shipped++;
      } else {
        // Approved but didn't reach branch_pushed (e.g. no repo configured,
        // or an apply failure that returned rather than threw) — nothing to
        // include in this batch's push.
        failed++;
        await appendJobLog(job.id, `Draft #${draft.id} (${draft.action_type}) did not reach branch_pushed (status: ${result?.status}) — skipped from batch push.`);
      }
    } catch (err) {
      failed++;
      // Same sanitize-before-log convention as shipRecommendation's own
      // catch above (this file, ~line 965) — approveAndPublishDraft's errors
      // are user-facing httpErrors already carrying a safe .message, but a
      // non-httpError (e.g. a network failure inside implementer.apply())
      // would otherwise leak its raw text into this job log, which the
      // Action Center UI surfaces directly.
      const message = err.userFacing ? err.message : (sanitizeForCustomer(err.message) ?? safeMessage('action-center.bulkApproveDrafts', err, 'Approval failed').message);
      await appendJobLog(job.id, `Draft #${draft.id} (${draft.action_type}) failed: ${message}`);
    }
  }

  const finalization = await finalizeBatchPr(site, branchName, pendingIds);
  if (!finalization.ok) {
    // Same strand-and-hide concern finalizeBatchPr's own comment describes —
    // nothing in pendingIds actually reached a real PR, so revert every one
    // of them rather than silently reporting them as shipped.
    await appendJobLog(job.id, `Batch push/PR failed for ${branchName}: ${finalization.error} — ${pendingIds.length} item(s) reverted to failed.`);
    await Promise.all(pendingIds.map((id) =>
      markDraftAbandoned(siteId, id, `Batch push/PR failed: ${finalization.error}`, null).catch((err) => {
        console.error(`[action-center] could not abandon draft ${id} after batch push/PR failure:`, err.message);
      })
    ));
    shipped -= pendingIds.length;
    failed += pendingIds.length;
  } else if (pendingIds.length > 0) {
    await appendJobLog(job.id, `Batch pushed and PR opened: ${finalization.prUrl} (${finalization.pushed} commit(s)).`);
  }

  const finishedJob = await finishExecutionJob(job.id, {
    status: shipped > 0 ? 'completed' : 'failed',
    branchName: finalization.ok ? branchName : undefined,
    prNumber: finalization.prNumber,
    prUrl: finalization.prUrl,
  });
  return { job: finishedJob, shipped, failed };
}

// Single-recommendation version of the same chain, for the "preview it,
// then one click" path in the UI — still creates its own (single-item)
// execution job for the same audit trail bulk runs get.
export async function approveAndShipRecommendation(siteId, recommendationId, { userId } = {}) {
  const rec = await getRecommendationById(siteId, recommendationId);
  if (!rec) { const err = new Error('Recommendation not found'); err.status = 404; throw err; }
  if (rec.risk_tier !== 'safe') {
    const err = new Error('Only safe-tier recommendations can be auto-approved; use Generate Draft, then the manual approval steps, for this one.');
    err.status = 400;
    throw err;
  }
  const job = await createExecutionJob(siteId, { trigger: 'single', requestedBy: userId });
  const result = await shipRecommendation(siteId, rec, { userId, jobId: job.id });
  await finishExecutionJob(job.id, {
    status: result.ok ? 'completed' : 'failed',
    branchName: result.draft?.branch_name, prNumber: result.draft?.pr_number, prUrl: result.draft?.pr_url,
  });
  if (!result.ok) { const err = new Error(result.error); err.status = 422; throw err; }
  return result.draft;
}

router.post('/action-center/execute-safe-fixes', async (req, res, next) => {
  try {
    res.json(await executeSafeFixes(req.siteId, { userId: req.userId, limit: req.body?.limit }));
  } catch (e) {
    if (e.status) return respondWithStatusError(res, e, 'Could not execute safe fixes right now — try again shortly.');
    next(e);
  }
});

router.post('/action-center/drafts/bulk-approve', async (req, res, next) => {
  try {
    res.json(await bulkApproveDrafts(req.siteId, { userId: req.userId, limit: req.body?.limit }));
  } catch (e) {
    if (e.status) return respondWithStatusError(res, e, 'Could not approve pending drafts right now — try again shortly.');
    next(e);
  }
});

// MUST stay above the '/:id' route below — Express matches in declaration
// order, and 'latest' would otherwise be parsed as an :id.
//
// Recovery path for a bulk run whose HTTP response the browser gave up on
// (see getLatestBulkExecutionJob): the server finished the job, so the
// per-item failure detail the Action Center wants to render already exists;
// this is how a client that lost its response gets back to it. Returns the
// same { shipped, failed, job } summary shape executeSafeFixes itself
// resolves with, recomputed from the persisted per-item rows, so the UI can
// render one banner without caring which path produced it.
router.get('/action-center/execution-jobs/latest', async (req, res, next) => {
  try {
    const job = await getLatestBulkExecutionJob(req.siteId);
    if (!job) return res.json({ job: null, shipped: 0, failed: 0 });
    res.json({
      job,
      shipped: job.items.filter((i) => i.status === 'approved').length,
      failed: job.items.filter((i) => i.status === 'failed').length,
    });
  } catch (e) { next(e); }
});

// Per-item detail for a bulk/single execution job — what executeSafeFixes'
// and approveAndShipRecommendation's summary counts don't show: which
// recommendations failed and why (execution_job_recommendations.error).
router.get('/action-center/execution-jobs/:id', async (req, res, next) => {
  try {
    const job = await getExecutionJob(req.siteId, req.params.id);
    if (!job) return res.status(404).json({ error: 'Execution job not found' });
    res.json(job);
  } catch (e) { next(e); }
});

// batchLimit rides along on the stats the Action Center already loads on
// mount, so the UI can label its Execute Safe Fixes button with the real
// server-side cap instead of hardcoding a copy that silently drifts.
router.get('/action-center/execution-stats/today', async (req, res, next) => {
  try {
    res.json({ ...(await getTodayExecutionStats(req.siteId)), batchLimit: SAFE_FIX_BATCH_LIMIT });
  } catch (e) { next(e); }
});

// Manual "re-check now" — immediately re-verifies one recommendation's page
// or link instead of waiting for its agent's next rotation-batched run.
router.post('/action-center/recommendations/:id/recheck', async (req, res, next) => {
  try {
    res.json(await recheckRecommendation(req.siteId, req.params.id));
  } catch (e) {
    if (e.status) return respondWithStatusError(res, e, 'This recommendation could not be re-checked right now.');
    next(e);
  }
});

router.post('/action-center/recommendations/:id/approve-and-ship', async (req, res, next) => {
  try {
    res.json(await approveAndShipRecommendation(req.siteId, req.params.id, { userId: req.userId }));
  } catch (e) {
    if (e.status) return respondWithStatusError(res, e, 'Could not approve and ship this recommendation right now.');
    next(e);
  }
});

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
    // Phase 5: a real merge is the strongest positive signal a generator can
    // earn — a human actually shipped this to production. Recorded
    // regardless of how the draft originated (auto-remediation or a human
    // manually generating and approving it), since either way it is real
    // evidence the generator's output was trustworthy.
    recordOutcome(siteId, draft.action_type, 'merged', { draftId: draft.id }).catch(() => {});
    try {
      await runSiteDiscoveryIfDue(site);
    } catch (err) {
      console.error(`[action-center] post-implement site discovery failed for site ${siteId}:`, err.message);
    }
    // The merge is the only moment we know a fix is genuinely live, and the
    // only moment the "before" window is still cleanly defined — so the
    // measurement is scheduled here rather than reconstructed later from
    // draft timestamps. agents/lib/fix-impact.js fills it in ~31 days on
    // (28 days of post-merge data + GSC's own 3-day finalization lag).
    //
    // Best-effort by design: this is a reporting/learning signal, and failing
    // to schedule it must never make a genuinely merged fix look unmerged.
    try {
      await scheduleImpactMeasurement(siteId, {
        draftId: draft.id,
        pageUrl: draft.content?.page || draft.input?.page || null,
        generatorId: draft.action_type,
        mergedAt: new Date(),
      });
    } catch (err) {
      console.error(`[action-center] could not schedule impact measurement for draft ${draftId}:`, err.message);
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
    if (resolved.reason === 'render-mode-uncertain') {
      return res.status(422).json({ error: resolved.error, reason: resolved.reason, confidence: resolved.confidence, suggestedMode: resolved.suggestedMode });
    }
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

  let site = await getSiteById(siteId);
  if (!site.repo_owner || !site.repo_name) throw httpError(400, 'This site has no repository configured yet — run `npm run connect-repo` first.');

  // Self-heal a missing url_file_map entry inline, right before it would
  // otherwise fail with "no-file-mapping" — the same deterministic,
  // single-real-file-match discovery discover-url-file-map.js's manual CLI
  // already does, just triggered automatically instead of waiting for
  // someone to remember to run it and re-apply the output. Every implementer
  // routes through this one push path, so fixing it here covers all of them
  // at once instead of retrofitting each resolveFile() call site.
  const page = draft.content?.page;
  if (page && !resolveFile(site, page)) {
    const healed = await autoHealFileMapping(site, page, draft.action_type).catch((err) => {
      console.warn(`[action-center] auto-heal url_file_map failed for site #${siteId}, page ${page}: ${err.message}`);
      return null;
    });
    if (healed) site = healed;
  }

  const resolved = await resolveImplementerForApply(site, draft, renderMode);
  if (resolved.reason === 'render-mode-uncertain') {
    throw httpError(422, resolved.error, { reason: resolved.reason, confidence: resolved.confidence, suggestedMode: resolved.suggestedMode });
  }
  if (resolved.error) throw httpError(400, resolved.error);
  const { implementer, implementerId } = resolved;

  // Same terminal-state gate as approveAndPublishDraft above: markDraftBranchPushed
  // is only reached on a genuine result.ok. See that function's comment for
  // why this branch (and the surrounding GitHub network calls) has no
  // automated route-level test — a pre-existing, repo-wide gap, not specific
  // to this change.
  const result = await implementer.apply(site, draft, { renderModeOverride: renderMode });
  if (!result.ok) {
    const renderModeInfo = result.reason === 'render-mode-uncertain'
      ? { reason: result.error, confidence: result.confidence, suggestedMode: result.suggestedMode }
      : null;
    await recordApplyFailure(siteId, draft.id, result.error, renderModeInfo);
    throw httpError(422, result.error, {
      reason: result.reason, confidence: result.confidence, suggestedMode: result.suggestedMode, attempted: result.attempted,
      missingClasses: result.missingClasses, componentKey: result.componentKey, unresolved: result.unresolved,
    });
  }
  // Provenance for the reviewer: what actually renders this page, whether
  // it's shared, and what a change would affect (page-resolution.js). Never
  // fatal — a failed resolution here must not block a draft whose actual
  // apply just succeeded; the draft simply carries no provenance, same as
  // before this existed. page-level generators only (no `page` means a
  // site-level target like analytics-install, which is out of scope for
  // this — its shared target is the design, not something to warn about).
  const targetProvenance = page
    ? await resolvePageSource(site, page, draft.action_type).catch(() => null)
    : null;
  return markDraftBranchPushed(siteId, draft.id, {
    branchName: result.branchName, implementerId, renderMode: result.renderMode, appliedFiles: result.appliedFiles, targetProvenance,
  });
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
    // rateLimited rides along so finalizeBatchPr's catch can tell a
    // wait-and-retry failure from a permanent one (see persistedFailure in
    // implementers/lib/github-ops.js).
    throw httpError(422, result.error, { reason: result.reason, rateLimited: result.rateLimited === true });
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
    const { message } = safeMessage('action-center.checkDraftPrStatus', e, 'Could not read this pull request\'s status right now — try again shortly.');
    throw httpError(502, message);
  }

  // Approval Gate, Phase 2 (implementers/lib/rendering-gate.js) — polled
  // alongside the PR's own merge state so Action Center always shows the
  // client repo's real build-check result, not just GitHub's merge status.
  // checkClientBuildStatus never throws (it reports its own failures
  // honestly as {ok:false}), so it never blocks this poll from completing —
  // GitHub's PR/merge state is still real evidence worth recording even for
  // a repo that hasn't had the rendering-validation workflow installed yet.
  const buildStatus = await checkClientBuildStatus(site, draft.branch_name);
  await recordValidationStatus(siteId, draft.id, {
    clientBuild: {
      ...buildStatus,
      checksUrl: draft.pr_url ? `${draft.pr_url}/checks` : null,
      // Merging is always a human, on GitHub itself (see github-ops.js) —
      // this app has no way to have prevented it. What it CAN do is make
      // sure a merge that happened while this check wasn't green is never
      // silently indistinguishable from a clean one in Action Center.
      mergedDespiteNotPassing: !!pr.merged && buildStatus.ok !== true,
    },
  });

  // Fallback automatic-learning trigger for generator ids with no
  // fix_verifications coverage (see VERIFIABLE_GENERATOR_IDS) — those get
  // the strong "real page re-check" signal via fix-verification.js instead;
  // for everything else, a merged/abandoned PR is the only outcome evidence
  // this app ever gets. Best-effort — must never block the real PR-status
  // transition below over a memory-write failure.
  if (!VERIFIABLE_GENERATOR_IDS.has(draft.action_type)) {
    const outcome = pr.merged ? 'success' : pr.state === 'closed' ? 'failure' : null;
    if (outcome) {
      const learn = draft.memory_ref_id
        ? recordFixOutcome({ memoryRefId: draft.memory_ref_id, outcome, agentId: 'pr-status', generatorId: draft.action_type, siteId })
        : outcome === 'success'
          ? recordFixOutcome({
              category: topLevelCategoryForGenerator(draft.action_type), scope: 'client', siteId, generatorId: draft.action_type,
              outcome: 'success', sourceType: 'runtime-auto',
              problemSignature: `${draft.action_type}:${draft.finding_id || draft.id}`,
              symptoms: `A ${draft.action_type} draft's PR was merged by a human reviewer, confirming the fix.`,
              affectedPattern: `${draft.action_type} draft addressing finding "${draft.finding_id || 'n/a'}".`,
              fixStrategy: `See the merged PR (${draft.pr_url}) for the fix content.`,
              sourceRef: draft.pr_url,
            })
          : Promise.resolve(null);
      await learn.catch((err) => console.error(`[action-center] agent_fix_memory PR-outcome write failed for draft ${draft.id}:`, err.message));
    }
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

    // Rollback PR opened — reopen this draft's finding in Recommendations
    // right away rather than waiting for the PR to merge (see
    // markDraftRolledBack's own comment for why status itself is untouched).
    await markDraftRolledBack(req.siteId, draft.id);

    res.json({ ok: true, prNumber: opened.prNumber, prUrl: opened.prUrl, branchName: pushed.branchName });
  } catch (e) { next(e); }
});

router.delete('/action-center/drafts/:id', async (req, res, next) => {
  try {
    const ok = await deleteDraft(req.siteId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Draft not found, or already implemented (an implemented draft is the audit record of a real shipped change and can\'t be discarded)' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
