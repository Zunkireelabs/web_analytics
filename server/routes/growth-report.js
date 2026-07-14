import { Router } from 'express';
import { requireAuth } from './login.js';
import { buildGrowthReport } from '../agents/lib/growth-report.js';

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

export default router;
