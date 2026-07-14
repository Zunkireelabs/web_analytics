import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { createConversation, listConversations, getConversation, getMessages, getRecentMessages, saveMessage } from '../store/copilot.js';
import { answerQuestion } from '../agents/lib/copilot.js';

const router = Router();
router.use(requireAuth, requireInternalSite);

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

    const result = await answerQuestion({ siteId: req.siteId, conversationId: convo.id, message, history });
    res.json({ conversationId: convo.id, ...result });
  } catch (e) { next(e); }
});

export default router;
