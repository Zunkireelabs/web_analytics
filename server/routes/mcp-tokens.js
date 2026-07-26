import { Router } from 'express';
import { requireAuth } from './login.js';
import { createApiToken, listApiTokensForSite, revokeApiToken } from '../store/api-tokens.js';
import { PERMISSION_LEVELS, DEFAULT_PERMISSION_LEVEL } from '../mcp/permissions.js';
import { getSiteById } from '../store/read.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

// Self-serve MCP token management — every logged-in client mints and
// revokes their own tokens, scoped to their own site (req.siteId, set by
// requireAuth). No internal-only gate: this is client-facing by design.
const router = Router();
router.use(requireAuth);

router.get('/mcp-tokens', async (req, res, next) => {
  try {
    res.json(await listApiTokensForSite(req.siteId));
  } catch (e) { next(e); }
});

router.post('/mcp-tokens', async (req, res, next) => {
  try {
    const { label, permissionLevel } = req.body || {};
    const level = permissionLevel || DEFAULT_PERMISSION_LEVEL;
    if (!PERMISSION_LEVELS.includes(level)) {
      return res.status(400).json({ error: `Invalid permission level "${level}".` });
    }
    const created = await createApiToken(req.siteId, {
      label: label ? String(label).trim() : null, createdBy: req.userId, permissionLevel: level,
    });
    res.json(created); // includes `token` (raw value) — one-time display
  } catch (e) { next(e); }
});

router.delete('/mcp-tokens/:id', async (req, res, next) => {
  try {
    const tokenId = Number(req.params.id);
    const ok = await revokeApiToken(req.siteId, tokenId);
    if (!ok) return res.status(404).json({ error: 'Token not found.' });

    const site = await getSiteById(req.siteId);
    await recordAuditEvent(req, {
      action: 'mcp_token.revoked',
      targetType: 'api_token',
      targetId: String(tokenId),
      tenantSiteId: req.siteId,
      tenantName: site?.name || null,
      metadata: { tokenId },
      success: true,
    });

    res.json({ revoked: true });
  } catch (e) { next(e); }
});

export default router;
