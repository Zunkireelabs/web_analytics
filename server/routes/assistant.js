import { Router } from 'express';
import { requireAuth } from './login.js';
import { getUserById } from '../store/users.js';
import { getSiteById } from '../store/read.js';
import { handleMessage } from '../assistant/assistant.js';
import { runStreamingChat, FRIENDLY_ERROR } from '../assistant/chat-stream.js';
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

// The same chat as /assistant/message, but streamed as server-sent events so the answer appears word by word (see
// assistant/chat-stream.js for the events). Same session-bound context; nothing about the site comes from the request.
router.post('/assistant/message/stream', async (req, res, next) => {
  try {
    const { message, conversationId } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    const ctx = await resolveContext(req);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx must not hold the words back
    });
    res.flushHeaders();

    // Closing the chat (or the tab) stops the model call instead of paying for an answer nobody will read.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const emit = (event) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    // A comment line every 15s keeps proxies from closing a connection that is waiting on a slow lookup.
    const heartbeat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n'); }, 15_000);
    try {
      await runStreamingChat({ ctx, message, conversationId: conversationId || null, emit, signal: controller.signal });
    } catch (err) {
      console.error('[assistant] stream failed:', err?.message || err);
      emit({ type: 'error', message: FRIENDLY_ERROR });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  } catch (e) {
    if (res.headersSent) return res.end();
    next(e);
  }
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
