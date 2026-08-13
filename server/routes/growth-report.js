import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { buildGrowthReport, getMetricLatestValue, GROWTH_TARGET_METRICS } from '../agents/lib/growth-report.js';
import { setGrowthTarget, getGrowthTargetHistory } from '../store/growth-targets.js';
import { getSiteById } from '../store/read.js';
import { runAiRecommendationIfDue } from '../job.js';

// Client-facing — the logged-in client's own site only (req.siteId from
// session), unlike Phase 4's staff-only /internal/clients/:id/review which
// takes an explicit :id since staff act on other sites' data.
const router = Router();
router.use(requireAuth);

router.get('/growth-report', async (req, res, next) => {
  try {
    res.json(await buildGrowthReport(req.siteId));
  } catch (e) { next(e); }
});

// Staff-only Milestones view of another client's site — the Milestones page
// (web/src/pages/GrowthReport.jsx) defaults to the caller's own site via the
// route above, but an internal admin can pick a different client from its
// picker, which re-fetches through here instead. Same requirePlatformRole
// gate (isInternal + platform_admin role, see server/routes/login.js) as the
// other staff-only cross-tenant routes (server/routes/keywords.js's
// /internal/keywords/:siteId/... family) — mirrored exactly rather than
// inventing a separate check, and :siteId is only ever trusted because this
// gate ran first.
router.get('/internal/growth-report/:siteId', requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    res.json(await buildGrowthReport(req.params.siteId));
  } catch (e) { next(e); }
});

// Shared by the single-metric and batch target routes below — validates one
// { metric, targetValue, targetDate } entry against an already-fetched real
// growth report and saves it. baseline_value is always resolved from that
// report, never taken from the request body, so a client can't set a
// fabricated starting point. Throws { status, error } on invalid input,
// caught by both callers.
async function saveOneTarget(siteId, report, { metric, targetValue, targetDate }) {
  if (!GROWTH_TARGET_METRICS.includes(metric)) {
    throw { status: 400, error: `metric must be one of: ${GROWTH_TARGET_METRICS.join(', ')}.` };
  }
  const numericTarget = Number(targetValue);
  if (!Number.isFinite(numericTarget)) {
    throw { status: 400, error: `targetValue for ${metric} must be a number.` };
  }
  if (!targetDate || Number.isNaN(new Date(targetDate).getTime())) {
    throw { status: 400, error: `targetDate for ${metric} must be a valid date.` };
  }
  return setGrowthTarget({
    siteId, metric, targetValue: numericTarget, targetDate,
    baselineValue: getMetricLatestValue(report, metric),
    baselineDate: new Date().toISOString().slice(0, 10),
  });
}

// Planned "here to here" growth target for one metric — used by each card's
// individual "edit target" affordance (GrowthTrendCard/PerformanceTrendCard).
router.post('/growth-targets', async (req, res, next) => {
  try {
    // includeGrowthPlan: false — this route only needs getMetricLatestValue,
    // not the LLM growth-plan narrative, so saving a target never
    // incidentally triggers (or races into) that real LLM call.
    const report = await buildGrowthReport(req.siteId, { includeGrowthPlan: false });
    if (!report?.available) {
      return res.status(422).json({ error: 'Growth targets need a real onboarding baseline first.' });
    }
    const row = await saveOneTarget(req.siteId, report, req.body || {});
    res.status(201).json(row);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.error });
    next(e);
  }
});

// Same as above, but for the Milestones page's "Plan Your Growth" banner —
// several metrics at once, sharing one target date, filled in only where the
// client cares to set a goal.
router.post('/growth-targets/batch', async (req, res, next) => {
  try {
    const { targets } = req.body || {};
    if (!Array.isArray(targets) || !targets.length) {
      return res.status(400).json({ error: 'targets must be a non-empty array of { metric, targetValue, targetDate }.' });
    }
    // includeGrowthPlan: false — this route only needs getMetricLatestValue,
    // not the LLM growth-plan narrative, so saving a target never
    // incidentally triggers (or races into) that real LLM call.
    const report = await buildGrowthReport(req.siteId, { includeGrowthPlan: false });
    if (!report?.available) {
      return res.status(422).json({ error: 'Growth targets need a real onboarding baseline first.' });
    }
    const saved = [];
    for (const t of targets) saved.push(await saveOneTarget(req.siteId, report, t || {}));
    res.status(201).json(saved);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.error });
    next(e);
  }
});

router.get('/growth-targets/:metric/history', async (req, res, next) => {
  try {
    const { metric } = req.params;
    if (!GROWTH_TARGET_METRICS.includes(metric)) {
      return res.status(400).json({ error: `metric must be one of: ${GROWTH_TARGET_METRICS.join(', ')}.` });
    }
    res.json(await getGrowthTargetHistory(req.siteId, metric));
  } catch (e) { next(e); }
});

// Milestones' first-run trigger for the AI Recommendation card, for when the
// agent is fully configured (OPENAI_API_KEY + AI_RECOMMENDATION_ENABLED) but
// has never actually run for this site yet — see
// growth-report.js's aiRecommendationTrend.configured. Reuses the exact same
// monthly-due cost guard the nightly cron uses (runAiRecommendationIfDue),
// so repeat clicks in the same month don't multiply real OpenAI spend — it
// simply no-ops (returns null) if this site already ran this month.
router.post('/growth-report/run-ai-recommendation', async (req, res, next) => {
  try {
    const site = await getSiteById(req.siteId);
    if (!site) return res.status(404).json({ error: 'Site not found.' });
    const result = await runAiRecommendationIfDue(site);
    if (!result) {
      return res.json({ ran: false, message: 'AI Recommendation already checked this month — see the card above for the latest result.' });
    }
    res.json({ ran: true, ...result });
  } catch (e) { next(e); }
});

export default router;
