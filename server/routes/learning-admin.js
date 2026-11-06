import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { getUserById } from '../store/users.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import { getGovernanceReport, getKnowledgeHistory, reviewKnowledge } from '../lib/learning-governance.js';
import { listModels, promoteModel, rollbackModel, rejectModel } from '../lib/model-adaptation.js';

// Platform-admin control of the shared learning and the model registry (Phases 6 and 7). The reviewer is NEVER taken from the
// request: it is the signed-in user's email, so a decision cannot be attributed to someone else. Every action, including a
// refused one, is written to the audit trail with an allowlisted payload (no request body passed through).
// Reads shared tables only (counts, no tenant data); it has no way to reach a project's or workspace's own data.

const asId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 500) : '');

// A refusal from the library (bad input, failed safety gate) is the caller's problem, not a server fault.
const isRefusal = (e) => /refused|required|No shared knowledge|No model|cannot be promoted|already active|no evaluat|nothing to roll back|not found/i.test(e?.message || '');

export function createHandlers(d = {}) {
  const deps = {
    getUser: getUserById, audit: recordAuditEvent, report: getGovernanceReport, history: getKnowledgeHistory, review: reviewKnowledge,
    models: listModels, promote: promoteModel, rollback: rollbackModel, reject: rejectModel, ...d,
  };
  const actorOf = async (req) => {
    const user = await deps.getUser(req.userId);
    if (!user?.email) throw Object.assign(new Error('no signed-in reviewer'), { status: 401 });
    return user.email;
  };
  // Runs an action as the signed-in admin and audits the outcome either way.
  const act = (action, targetType, run) => async (req, res, next) => {
    const targetId = req.params?.id ? String(req.params.id) : null;
    try {
      const by = await actorOf(req);
      const reason = text(req.body?.reason);
      const result = await run({ req, by, reason });
      await deps.audit(req, { action, targetType, targetId, success: true, metadata: { reason } });
      res.json({ ok: true, ...result });
    } catch (e) {
      await deps.audit(req, { action, targetType, targetId, success: false, errorMessage: String(e.message).slice(0, 300), metadata: { reason: text(req.body?.reason) } });
      if (e.status) return res.status(e.status).json({ error: e.message });
      if (isRefusal(e)) return res.status(400).json({ error: e.message });
      return next(e);
    }
  };
  return {
    report: async (req, res, next) => { try { res.json(await deps.report()); } catch (e) { next(e); } },
    history: async (req, res, next) => {
      try {
        const id = asId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid id.' });
        res.json(await deps.history({ id }));
      } catch (e) { next(e); }
    },
    review: act('learning.review', 'industry_knowledge', async ({ req, by, reason }) => {
      const id = asId(req.params.id);
      if (!id) throw new Error('Review refused: a knowledge id is required');
      const row = await deps.review({ id, state: text(req.body?.state), by, reason });
      return { id: row.id, reviewState: row.review_state };
    }),
    models: async (req, res, next) => { try { res.json(await deps.models()); } catch (e) { next(e); } },
    promote: act('model.promote', 'model_registry', async ({ req, by, reason }) => {
      const id = asId(req.params.id);
      if (!id) throw new Error('Promotion refused: a model id is required');
      const m = await deps.promote(id, { by, reason });
      return { id: m.id, status: m.status };
    }),
    rollback: act('model.rollback', 'model_registry', async ({ by, reason }) => ({ ...(await deps.rollback({ by, reason })) })),
    rejectModel: act('model.reject', 'model_registry', async ({ req, by, reason }) => {
      const id = asId(req.params.id);
      if (!id) throw new Error('Rejection refused: a model id is required');
      const m = await deps.reject(id, { by, reason });
      return { id: m.id, status: m.status };
    }),
  };
}

const router = Router();
const staff = [requireAuth, requirePlatformRole('platform_admin')];
const h = createHandlers();
router.get('/internal/learning/industry', ...staff, h.report);
router.get('/internal/learning/industry/:id/history', ...staff, h.history);
router.post('/internal/learning/industry/:id/review', ...staff, h.review);
router.get('/internal/models', ...staff, h.models);
router.post('/internal/models/rollback', ...staff, h.rollback);
router.post('/internal/models/:id/promote', ...staff, h.promote);
router.post('/internal/models/:id/reject', ...staff, h.rejectModel);

export default router;
