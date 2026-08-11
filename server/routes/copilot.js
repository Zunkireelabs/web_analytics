import { Router } from 'express';
import { requireAuth } from './login.js';
import { createConversation, listConversations, getConversation, getMessages, getRecentMessages, saveMessage } from '../store/copilot.js';
import { answerQuestion } from '../agents/lib/copilot.js';
import { buildGreeting } from '../agents/lib/copilot-greeting.js';

const router = Router();

// Client-facing as of this change: the Copilot used to be gated behind
// requirePlatformRole('platform_admin'), so a client could never reach it at
// all. It is now `requireAuth` only, like the rest of the growth tooling
// (agents.js, command-center.js, action-center.js, site-audit.js).
//
// The safety property that makes that sound is unchanged and load-bearing:
// every route below scopes on `req.siteId` from the SESSION, never on a
// client-supplied id, and the agentic loop it delegates to does the same —
// runAgenticLoop takes siteId from this closure and the model has no tool
// parameter that can override it (agentic-orchestrator.js's AGENT_TOOL_PARAMS
// are `additionalProperties: false` and carry no site field). The one genuinely
// new exposure from opening this up — the inspect_* tools fetching a
// model-supplied URL server-side — is closed in the same change by
// checkInspectableUrl, which allowlists the tenant's own domain.
//
// What a client sees differs from what staff see by AUDIENCE, not by data
// scope: both only ever see their own site. See copilot-greeting.js.
router.use(requireAuth);

// The opening line, before the user has typed anything. Deliberately its own
// endpoint rather than a canned frontend string: it reports real current state
// (open vs design-blocked recommendations for THIS site) and adapts to whether
// a platform admin or a site owner is reading, which the client cannot know.
router.get('/copilot/greeting', async (req, res, next) => {
  try { res.json(await buildGreeting({ siteId: req.siteId, userId: req.userId })); } catch (e) { next(e); }
});

router.get('/copilot/conversations', async (req, res, next) => {
  try { res.json(await listConversations(req.siteId)); } catch (e) { next(e); }
});

router.get('/copilot/conversations/:id/messages', async (req, res, next) => {
  try {
    const convo = await getConversation(req.siteId, req.params.id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    res.json(await getMessages(req.params.id));
  } catch (e) { next(e); }
});

// Creates a new conversation on first ask (conversationId omitted), or
// continues an existing one. Persists both the user's message and the
// assistant's reply, so a reload never loses the thread.
router.post('/copilot/ask', async (req, res, next) => {
  try {
    const { conversationId, message } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

    let convo;
    if (conversationId) {
      convo = await getConversation(req.siteId, conversationId);
      if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    } else {
      convo = await createConversation(req.siteId, message.slice(0, 80));
    }

    const history = await getRecentMessages(convo.id, 8);
    await saveMessage(convo.id, 'user', message);

    const result = await answerQuestion({ siteId: req.siteId, conversationId: convo.id, message, history, userId: req.userId });
    res.json({ conversationId: convo.id, ...result });
  } catch (e) { next(e); }
});

export default router;
