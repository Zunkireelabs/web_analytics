import { Router } from 'express';
import { requireAuth } from './login.js';
import { getIntegrationHealth } from '../store/read.js';
import { callDataAnalystAgent } from '../lib/data-analyst-client.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { listRecentDraftsWithPage, listOpenRecommendationPages, listMeasuredDraftIds, listRisingQueries } from '../store/analyst-outlook.js';
import { listMeasuredImpact } from '../store/fix-impact.js';
import { draftForPredictedKeyword } from '../agents/lib/analyst-keyword-draft.js';
import { findDraftByTopic } from '../store/ai-recommendation.js';
import { buildOutlook, buildFixes, buildProblems, buildShifts, pathKey } from '../agents/lib/analyst-outlook.js';

// Two client-only endpoints for the Analyst page that have no staff
// equivalent to mirror (see the mirror in routes/dataAnalyst.js for the rest).
// Both read the session's own site (req.siteId) and nothing from the request.
const router = Router();
router.use('/analyst', requireAuth);

// The fixed briefing question. It lives HERE, not in the browser: the page used
// to send it through the staff-only assistant capability (ask_analyst_data),
// which let the caller choose the question. A client gets exactly this one.
const BRIEFING_PROMPT = "Give me a 2-3 sentence executive briefing on this client's current performance — what's going well, what needs attention, in plain language.";

// One model call per site per half hour, however many times the page is opened.
const BRIEFING_TTL_MS = 30 * 60 * 1000;
const briefingCache = new Map(); // siteId -> { at, answer }

router.get('/analyst/briefing', async (req, res, next) => {
  try {
    const cached = briefingCache.get(req.siteId);
    if (cached && Date.now() - cached.at < BRIEFING_TTL_MS) return res.json({ answer: cached.answer });
    const result = await callDataAnalystAgent(`/ask/${req.siteId}`, { method: 'POST', body: { question: BRIEFING_PROMPT } });
    const answer = typeof result?.answer === 'string' ? result.answer : null;
    if (answer) briefingCache.set(req.siteId, { at: Date.now(), answer });
    res.json({ answer });
  } catch (e) {
    // The briefing is a nicety on top of the page: a failure is "no briefing", not an error screen.
    res.json({ answer: null });
  }
});

// Whether Search Console is connected for this site — the keyword and growth
// sections are all built from it, so the page can say so instead of looking
// empty. Same data as the staff-only /integrations/health, narrowed to this one flag.
router.get('/analyst/connections', async (req, res, next) => {
  try {
    const rows = await getIntegrationHealth(req.siteId);
    const gsc = rows.find((r) => r.integration_id === 'google-oauth');
    res.json({ gscConnected: gsc ? gsc.status === 'ok' : null });
  } catch (e) { next(e); }
});


// ── Outlook and Fixes subpages ───────────────────────────────────────────────
// Both read only what the nightly passes already persisted (the Python service's predictions, this
// app's recommendations, drafts and measured fixes). Neither triggers a run, and both take the site
// from the session, never from the request.

async function pythonOrNull(path) {
  try { return await callDataAnalystAgent(path); } catch { return null; }
}

async function problemContext(siteId, issues) {
  const [drafts, recPages, measuredIds] = await Promise.all([
    listRecentDraftsWithPage(siteId),
    listOpenRecommendationPages(siteId),
    listMeasuredDraftIds(siteId),
  ]);
  const ctx = { drafts, openRecommendationPages: new Set(recPages.map(pathKey)), measuredDraftIds: new Set(measuredIds) };
  return { drafts, problems: buildProblems(issues, ctx) };
}

router.get('/analyst/outlook', async (req, res, next) => {
  try {
    const [py, issuesRes, runs, rising] = await Promise.all([
      pythonOrNull(`/clients/${req.siteId}/outlook`),
      pythonOrNull(`/clients/${req.siteId}/predicted-issues?weeks=1`),
      getLatestAgentRuns(req.siteId, ['trend-radar']).catch(() => []),
      listRisingQueries(req.siteId).catch(() => []),
    ]);
    const { problems } = await problemContext(req.siteId, issuesRes?.issues || []);
    const radar = runs.find((r) => r.agent_id === 'trend-radar' && r.status === 'ok');
    const shifts = buildShifts({ radarTopics: radar?.facts?.topics || [], risingQueries: rising, industry: py?.industry || null });
    const body = buildOutlook({ py: py || { status: 'not-ready', message: 'The Analyst service is not reachable right now. Try again in a minute.' }, problems, shifts });
    res.json(body);
  } catch (e) { next(e); }
});

router.get('/analyst/fixes', async (req, res, next) => {
  try {
    const issuesRes = await pythonOrNull(`/clients/${req.siteId}/predicted-issues?weeks=3`);
    const { problems, drafts } = await problemContext(req.siteId, issuesRes?.issues || []);
    const measured = await listMeasuredImpact(req.siteId, 30);
    res.json(buildFixes({ problems, measured, drafts }));
  } catch (e) { next(e); }
});

// Approving a problem that is waiting for a person: the id is the predicted issue, and the draft
// is looked up server-side so a client can never name some other draft to approve.
router.post('/analyst/fixes/:id/approve', async (req, res, next) => {
  try {
    const issuesRes = await pythonOrNull(`/clients/${req.siteId}/predicted-issues?weeks=3`);
    const issue = (issuesRes?.issues || []).find((i) => String(i.id) === String(req.params.id));
    if (!issue) return res.status(404).json({ error: 'That problem was not found.' });
    const { problems } = await problemContext(req.siteId, [issue]);
    const p = problems[0];
    if (p.stage !== 'needs-ok' || !p.draftId) return res.status(409).json({ error: 'There is nothing waiting for your OK on this problem.' });
    // Loaded here, not at the top: action-center.js drags in most of the app, which this router's
    // tests (and every request that never approves anything) should not have to pay for.
    const { approveAndPublishDraft } = await import('./action-center.js');
    res.json(await approveAndPublishDraft(req.siteId, p.draftId, { userId: req.userId }));
  } catch (e) { next(e); }
});

// "Write for it": drafts a post for one of the keywords the Analyst predicts can grow. The keyword is
// checked against the Analyst's own current list, never taken on trust from the request.
router.post('/analyst/keywords/write', async (req, res, next) => {
  try {
    const py = await pythonOrNull(`/clients/${req.siteId}/outlook`);
    const { generateDraft } = await import('./action-center.js'); // lazy, same reason as the approve route
    res.json(await draftForPredictedKeyword(req.siteId, req.body?.keyword, {
      predicted: py?.keywords || [], findDraftByTopic, generate: generateDraft,
    }));
  } catch (e) { next(e); }
});

export default router;
