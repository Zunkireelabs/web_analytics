import { Router } from 'express';
import { requireAuth } from './login.js';
import { PROVIDERS } from '../agents/lib/model-providers/index.js';
import { buildBoard } from '../agents/lib/ai-visibility-board.js';
import {
  listPromptsWithRuns, upsertTrackedPrompt, countActiveCustomPrompts, requestPromptShip,
  setPromptDraft, setPromptShipError, findDraftByTopic,
} from '../store/ai-recommendation.js';
import { query } from '../db.js';

const router = Router();
router.use(requireAuth);

const MIN_PROMPT = 8;
const MAX_PROMPT = 200;
const MAX_CUSTOM = 100;
const MAX_SHIP = 25;

// Reads only what the AI-recommendation agent already persisted — never probes an engine.
router.get('/ai-visibility', async (req, res, next) => {
  try {
    const siteId = req.siteId;
    const [{ prompts, runs }, pagesRes] = await Promise.all([
      listPromptsWithRuns(siteId),
      query(`SELECT page FROM page_inventory WHERE site_id = $1 AND orphaned = false LIMIT 500`, [siteId]).catch(() => ({ rows: [] })),
    ]);
    const board = buildBoard({ prompts, runs, pages: pagesRes.rows.map((r) => r.page) });
    res.json({
      engines: PROVIDERS.map((p) => ({ id: p.id, configured: p.configured() })),
      trackedCount: prompts.length,
      ...board,
    });
  } catch (e) { next(e); }
});

// A person's own prompt. It is checked the next time the agent probes (the same rotation
// that handles agent-derived prompts, never-checked first), so it shows up in the lists then.
router.post('/ai-visibility/prompts', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_PROMPT || text.length > MAX_PROMPT) {
      return res.status(400).json({ error: `A prompt needs ${MIN_PROMPT}-${MAX_PROMPT} characters.` });
    }
    if (await countActiveCustomPrompts(req.siteId) >= MAX_CUSTOM) {
      return res.status(400).json({ error: `You can track up to ${MAX_CUSTOM} of your own prompts.` });
    }
    const row = await upsertTrackedPrompt(req.siteId, text, 'custom');
    res.status(201).json({ id: row.id, promptText: row.prompt_text });
  } catch (e) { next(e); }
});

// Marks the ticked prompts to ship. `now: true` generates their drafts straight away (the same
// blog-outline draft the daily run produces, landing in Action Center under its normal
// approval rules); otherwise they are left for the daily run (job.js runAiVisibilityShipForAllSites).
router.post('/ai-visibility/ship', async (req, res, next) => {
  try {
    const ids = [...new Set((req.body?.promptIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one prompt.' });
    if (ids.length > MAX_SHIP) return res.status(400).json({ error: `Ship at most ${MAX_SHIP} prompts at a time.` });
    const marked = await requestPromptShip(req.siteId, ids);
    const results = { queued: marked.length, drafted: 0, failed: 0 };
    if (req.body?.now) {
      const { shipPromptDraft } = await import('../agents/lib/ai-visibility-ship.js');
      for (const p of marked) {
        const r = await shipPromptDraft(req.siteId, p, { findDraftByTopic, setPromptDraft, setPromptShipError });
        if (r.ok) { results.drafted++; results.queued--; } else results.failed++;
      }
    }
    res.json(results);
  } catch (e) { next(e); }
});

export default router;
