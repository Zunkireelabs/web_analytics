import { Router } from 'express';
import { requireAuth } from './login.js';
import { listProspects, getProspectById, approveProspectForCrm } from '../store/prospects.js';
import { listTrialSignups } from '../store/trial-signups.js';

// Client-facing Demand page (web/src/pages/Demand.jsx) — session-scoped to
// req.siteId exactly like metrics.js, never a staff cross-client view.
// Approving a prospect here is the human-approval gate the Product Growth
// spec requires before it can ever appear in the CRM export pull (see
// server/routes/crm-webhook.js) — the site owner, not this platform, decides
// which real prospects are worth an outreach attempt.
const router = Router();
router.use(requireAuth);

router.get('/demand/prospects', async (req, res, next) => {
  try {
    res.json(await listProspects(req.siteId));
  } catch (e) { next(e); }
});

// "See it live" self-serve trial signups, classified as a genuine
// prospect vs. a competitor suspect (server/routes/trial-signup.js) —
// listing them here is the whole feature for now; blocking a suspected
// account is a manual, human decision made outside this platform.
router.get('/demand/trial-signups', async (req, res, next) => {
  try {
    res.json(await listTrialSignups(req.siteId));
  } catch (e) { next(e); }
});

router.post('/demand/prospects/:id/approve', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await getProspectById(req.siteId, id);
    if (!existing) return res.status(404).json({ error: `No prospect found with id ${id} for this site.` });

    res.json(await approveProspectForCrm(req.siteId, id));
  } catch (e) { next(e); }
});

export default router;
