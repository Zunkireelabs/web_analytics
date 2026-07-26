import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { listAllApiTokensAcrossSites, getApiTokenSiteId } from '../store/admin/mcp-tokens.js';
import { revokeApiToken } from '../store/api-tokens.js';
import { getSiteById } from '../store/read.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

// Platform MCP oversight (PLATFORM-ADMIN-DESIGN.md §F.6, §G.2, §K Phase 5)
// — cross-tenant read/audit layer over the existing self-serve token flow
// (server/routes/mcp-tokens.js), never a replacement for it. Deliberately
// its own file, not folded into clients.js or mcp-tokens.js: the store
// functions it calls live under server/store/admin/ specifically so they
// can never be imported by mistake into a tenant-facing route file, and
// this router is the only caller of them.
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

router.get('/internal/mcp-tokens', async (req, res, next) => {
  try {
    res.json(await listAllApiTokensAcrossSites());
  } catch (e) { next(e); }
});

// Reuses revokeApiToken(siteId, id) exactly as the self-serve route does —
// the only difference is siteId comes from the token row itself (looked up
// first) rather than the caller's own req.siteId, which for a platform
// admin is always COMPANY_SITE_ID and would never match the target token.
router.post('/internal/mcp-tokens/:id/revoke', async (req, res, next) => {
  try {
    const tokenId = Number(req.params.id);
    const siteId = await getApiTokenSiteId(tokenId);
    if (!siteId) return res.status(404).json({ error: 'Token not found.' });

    const ok = await revokeApiToken(siteId, tokenId);
    if (!ok) return res.status(404).json({ error: 'Token not found or already revoked.' });

    const site = await getSiteById(siteId);
    await recordAuditEvent(req, {
      action: 'mcp_token.revoked',
      targetType: 'api_token',
      targetId: String(tokenId),
      tenantSiteId: siteId,
      tenantName: site?.name || null,
      metadata: { tokenId },
      success: true,
    });

    res.json({ revoked: true });
  } catch (e) { next(e); }
});

export default router;
