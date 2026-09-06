import { Router } from 'express';
import { requireAuth } from './login.js';
import { getUserById } from '../store/users.js';
import { getSiteById } from '../store/read.js';
import { handleMessage } from '../assistant/assistant.js';
import { invokeCapability, capabilitiesFor } from '../assistant/capabilities.js';

const router = Router();
router.use(requireAuth);

// Resolves { siteId, userId, role } from the SESSION only (§19/§20) — never
// from the request body or a query string a client fully controls. The one
// exception, `siteId` override, is itself gated on the resolved role: a
// platform_admin genuinely manages many client sites (same pattern as
// Milestones' isInternal picker), but a tenant user's ctx.siteId is always
// exactly their own session's site, with no code path to change it.
async function resolveContext(req) {
  const user = await getUserById(req.userId).catch(() => null);
  const role = user?.role || 'tenant_member';

  let siteId = req.siteId;
  if (role === 'platform_admin' && req.query.siteId) {
    const requested = Number(req.query.siteId);
    if (Number.isInteger(requested)) {
      const site = await getSiteById(requested).catch(() => null);
      // Only switches context to a site that actually exists — an invalid id
      // falls back to the admin's own session site rather than producing a
      // ctx that points nowhere.
      if (site) siteId = requested;
    }
  }
  return { siteId, userId: req.userId, role };
}

router.post('/assistant/message', async (req, res, next) => {
  try {
    const { message, conversationId } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    const ctx = await resolveContext(req);
    const result = await handleMessage({ ctx, message, conversationId: conversationId || null });
    res.json(result);
  } catch (e) { next(e); }
});

// Direct capability invocation for the UI's structured actions (confirm
// button, "run discovery" button) — bypasses intent classification entirely,
// since a UI button already knows exactly which capability it means. Same
// authorization path as the conversational route; nothing here is more
// privileged for being invoked directly.
router.post('/assistant/invoke/:capability', async (req, res, next) => {
  try {
    const ctx = await resolveContext(req);
    const result = await invokeCapability(req.params.capability, ctx, req.body || {});
    res.status(result.ok ? 200 : (result.error === 'not-authorized' ? 403 : 400)).json(result);
  } catch (e) { next(e); }
});

router.get('/assistant/capabilities', async (req, res, next) => {
  try {
    const ctx = await resolveContext(req);
    res.json(capabilitiesFor(ctx.role));
  } catch (e) { next(e); }
});

export default router;
