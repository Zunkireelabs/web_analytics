import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { listWatchlist, setWatchlistStatus } from '../store/watchlist.js';

const router = Router();
router.use(requireAuth, requireInternalSite);

// Reads only already-synced data — sync itself happens as part of a fresh
// analysis run (job.js's daily run, or Command Center's refresh route),
// same "instant, may be stale until the next real analysis" contract as
// every other cached read in this app.
router.get('/watchlist', async (req, res, next) => {
  try {
    const { status } = req.query;
    res.json(await listWatchlist(req.siteId, { status }));
  } catch (e) { next(e); }
});

const VALID_STATUSES = new Set(['new', 'in_progress', 'completed', 'no_longer_applicable']);
const MANUAL_REASON = {
  in_progress: 'User marked as in progress.',
  completed: 'User marked as complete.',
  no_longer_applicable: 'User dismissed.',
  new: 'User reopened.',
};

// User-driven status change — e.g. "Mark In Progress" or "Dismiss" — distinct
// from the automatic transitions syncWatchlist() applies after each run.
router.patch('/watchlist/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
    const updated = await setWatchlistStatus(req.siteId, req.params.id, status, MANUAL_REASON[status]);
    if (!updated) return res.status(404).json({ error: 'Watchlist item not found' });
    res.json(updated);
  } catch (e) { next(e); }
});

export default router;
