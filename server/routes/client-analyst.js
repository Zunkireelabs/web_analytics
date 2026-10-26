import { Router } from 'express';
import { requireAuth } from './login.js';
import { getIntegrationHealth } from '../store/read.js';
import { callDataAnalystAgent } from '../lib/data-analyst-client.js';

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

export default router;
