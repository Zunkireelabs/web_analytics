import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import {
  getKeywordClusters, getKeywordGaps, updateKeywordGapStatus, getSiteProfile,
  getLatestKeywordNarrative,
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

export default router;
