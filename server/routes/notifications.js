import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { listNotifications, unreadCount, markRead, markAllRead } from '../store/notifications.js';

const router = Router();
router.use(requireAuth, requireInternalSite);

router.get('/notifications', async (req, res, next) => {
  try {
    const [items, unread] = await Promise.all([listNotifications(req.siteId), unreadCount(req.siteId)]);
    res.json({ items, unread });
  } catch (e) { next(e); }
});

router.post('/notifications/:id/read', async (req, res, next) => {
  try { await markRead(req.siteId, req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

router.post('/notifications/read-all', async (req, res, next) => {
  try { await markAllRead(req.siteId); res.json({ ok: true }); } catch (e) { next(e); }
});

export default router;
