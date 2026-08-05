import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { callLLM } from '../llm.js';
import {
  getKeywordClusters, getKeywordGaps, updateKeywordGapStatus, getSiteProfile,
  getLatestKeywordNarrative, getAnomalyAlerts, getLatestForecastStatuses,
  getLatestLayoutSuggestion, saveLayoutSuggestion,
} from '../store/data-analyst.js';

// Keyword Discovery — clusters/gaps/site-profile produced by agents/clustering.py
// (see server/store/data-analyst.js for the read/write layer). Unlike
// server/routes/dataAnalyst.js, these tables live in this app's own Neon
// Postgres already (post schema-merge), so there's no Python proxy here —
// each handler just calls the store function and re-throws through Express's
// error middleware, same thin-passthrough discipline. Staff-only, cross-client,
// same gate as dataAnalyst.js.
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

router.get('/internal/keywords/:siteId/clusters', async (req, res, next) => {
  try {
    const { cluster_type: clusterType } = req.query;
    res.json(await getKeywordClusters(req.params.siteId, clusterType));
  } catch (e) { next(e); }
});

router.get('/internal/keywords/:siteId/gaps', async (req, res, next) => {
  try {
    const { status } = req.query;
    res.json(await getKeywordGaps(req.params.siteId, status));
  } catch (e) { next(e); }
});

// status vocabulary here matches getKeywordGaps' own output exactly
// (pending_review/approved/rejected — see GAP_STATUS_FROM_DB in
// server/store/data-analyst.js) so a value read from GET .../gaps can be
// round-tripped straight back through this route with no translation.
router.put('/internal/keywords/:siteId/gaps/:gapId', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      const err = new Error("status must be 'approved' or 'rejected'.");
      err.status = 400;
      throw err;
    }
    const updated = await updateKeywordGapStatus(req.params.siteId, req.params.gapId, status);
    if (!updated) {
      const err = new Error('Keyword gap not found.');
      err.status = 404;
      throw err;
    }
    res.json(updated);
  } catch (e) { next(e); }
});

router.get('/internal/keywords/:siteId/profile', async (req, res, next) => {
  try {
    res.json(await getSiteProfile(req.params.siteId));
  } catch (e) { next(e); }
});

// Supplementary narrative — server/agents/keyword-narrative.js, separate
// from the Python executive-summary pipeline. Returns the latest row or
// null if the 14-day job hasn't run yet for this site.
router.get('/internal/keywords/:siteId/narrative', async (req, res, next) => {
  try {
    res.json(await getLatestKeywordNarrative(req.params.siteId));
  } catch (e) { next(e); }
});

// Section ids the Analyst page renders — see DEFAULT_SECTIONS in
// web/src/pages/Analyst.jsx. Kept here as the server-side source of truth
// for validating Claude's response so a malformed/missing id can never drop
// a section from the frontend's layout.
const LAYOUT_SECTION_IDS = ['hero', 'fixes', 'summary', 'priorities', 'studio', 'workspace', 'diagnostics', 'correlations', 'keyword-discovery'];

const LAYOUT_SYSTEM_PROMPT = `You are a dashboard layout optimizer.
Given the current state of a website's
analytics, decide which sections of the
analyst dashboard are most important to
show first today.

Available sections (use exact ids):
- hero (Prediction Readout)
- fixes (Proactive Fix Board)
- summary (AI Executive Summary)
- priorities (Recommendation Priority)
- studio (Predictive Intelligence Studio)
- workspace (Investigation Workspace)
- diagnostics (Diagnostic Tools)
- correlations (Correlation Explorer)
- keyword-discovery (Keyword Discovery)

Rules:
- If anomalies detected → put fixes first
- If keyword gaps exist → put keyword-discovery
  in top 4
- If forecast errors → put hero + diagnostics first
- Always keep summary in top 3
- Return ALL 9 section ids in priority order

Return only JSON, no other text:
{
  layout: [array of 9 section ids in order],
  reason: one sentence explaining top priority
}`;

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Best-effort JSON extraction — Claude is instructed to return raw JSON, but
// this tolerates an accidental markdown code fence around it.
function parseLayoutResponse(raw) {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* give up below */ } }
  return null;
}

function isValidLayout(layout) {
  return Array.isArray(layout)
    && layout.length === LAYOUT_SECTION_IDS.length
    && new Set(layout).size === LAYOUT_SECTION_IDS.length
    && layout.every((id) => LAYOUT_SECTION_IDS.includes(id));
}

// AI-suggested section order for today — see web/src/pages/Analyst.jsx's
// loadAILayout. Reuses the same site data as the keyword narrative
// (site_profiles, keyword_gaps) plus anomalies/forecast_runs status, and
// caches the result in layout_suggestions so this isn't a fresh Claude call
// on every page load — only when the day changes or the underlying
// anomaly/gap counts actually move.
router.get('/internal/keywords/:siteId/layout', async (req, res, next) => {
  try {
    const siteId = req.params.siteId;
    const [profile, gaps, anomalies, forecastStatuses] = await Promise.all([
      getSiteProfile(siteId),
      getKeywordGaps(siteId, 'pending_review'),
      getAnomalyAlerts(siteId),
      getLatestForecastStatuses(siteId),
    ]);

    const anomalyCount = anomalies.length;
    const gapCount = gaps.length;

    const cached = await getLatestLayoutSuggestion(siteId);
    const generatedToday = cached && new Date(cached.generated_at).toDateString() === new Date().toDateString();
    const cachedSignature = cached?.layout_json?.signature;
    const signatureUnchanged = cachedSignature
      && cachedSignature.anomalyCount === anomalyCount
      && cachedSignature.gapCount === gapCount;

    if (cached && generatedToday && signatureUnchanged && isValidLayout(cached.layout_json.layout)) {
      return res.json({ layout: cached.layout_json.layout, reason: cached.reason, generated_at: cached.generated_at });
    }

    const topGaps = [...gaps].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3)).slice(0, 5);
    const recentAnomalies = anomalies.slice(0, 3);
    const forecastIssues = forecastStatuses.some((f) => f.status !== 'ok');

    const facts = {
      industry: profile?.industry ?? null,
      siteType: profile?.site_type ?? null,
      mainTopics: profile?.main_topics ?? null,
      keywordGaps: topGaps.map((g) => ({ topic: g.topic, priority: g.priority })),
      recentAnomalies: recentAnomalies.map((a) => ({ metric: a.metric_key, direction: a.direction, score: a.score, createdAt: a.created_at })),
      forecastIssues,
    };

    let parsed = null;
    try {
      const raw = await callLLM(LAYOUT_SYSTEM_PROMPT, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 300 });
      parsed = parseLayoutResponse(raw);
    } catch (err) {
      console.warn('[keywords] layout suggestion LLM call failed:', err.message);
    }

    const layout = isValidLayout(parsed?.layout) ? parsed.layout : LAYOUT_SECTION_IDS;
    const reason = typeof parsed?.reason === 'string' ? parsed.reason : null;

    const saved = await saveLayoutSuggestion(siteId, { layout, signature: { anomalyCount, gapCount } }, reason);
    res.json({ layout, reason, generated_at: saved.generated_at });
  } catch (e) { next(e); }
});

export default router;
