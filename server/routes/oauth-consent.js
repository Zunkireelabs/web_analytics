import { Router } from 'express';
import { requireAuth } from './login.js';
import { getSiteById } from '../store/read.js';
import { getClientById } from '../store/oauth-clients.js';
import { createAuthorizationCode } from '../store/oauth-authorization-codes.js';
import { computeEffectivePermissionLevel } from '../../mcp-server/oauth-provider.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';

// Session-cookie-gated (requireAuth), mounted under /api alongside
// mcp-tokens.js — backs the consent screen at web/src/pages/OAuthAuthorize.jsx.
//
// Neither route here accepts a `permissionLevel` field from the request body
// or query string, even though a malicious or buggy OAuth client could send
// one — computeEffectivePermissionLevel (mcp-server/oauth-provider.js) is
// the only source of that value, derived from req.siteId (the logged-in
// user's own site, from their session — never client-supplied) and
// sites.oauth_max_permission_level (staff-set, migration 061).
const router = Router();
router.use(requireAuth);

// Plain-language, display-only description of what a computed level grants —
// mirrors web/src/components/McpTokensCard.jsx's TIERS copy for the manual-
// token UI. Duplicated rather than shared, same as that file already is
// relative to mcp-server/permissions.js — there's no shared constants module
// for this copy anywhere in the codebase yet.
const CAPABILITY_COPY = {
  read_only: 'View reports, analytics, and drafts. Cannot change anything.',
  ai_actions: 'View reports and analytics, plus run agents and generate or edit drafts. No GitHub access.',
  automation: 'Everything AI Actions can do, plus push branches and open pull requests. Never merges automatically — review stays manual.',
};

function scopesFromParam(scope) {
  return typeof scope === 'string' && scope.trim() ? scope.trim().split(/\s+/) : [];
}

router.get('/oauth/authorize-info', async (req, res, next) => {
  try {
    const { client_id: clientId, redirect_uri: redirectUri, scope } = req.query;
    if (!clientId || typeof clientId !== 'string') return res.status(400).json({ error: 'client_id is required.' });

    const client = await getClientById(clientId);
    if (!client) return res.status(404).json({ error: 'Unknown OAuth client.' });

    if (redirectUri && typeof redirectUri === 'string' &&
        !client.redirect_uris.some((registered) => redirectUriMatches(redirectUri, registered))) {
      return res.status(400).json({ error: 'redirect_uri is not registered for this client.' });
    }

    const site = await getSiteById(req.siteId);
    const effectivePermissionLevel = await computeEffectivePermissionLevel(req.siteId, scopesFromParam(scope));

    res.json({
      clientName: client.client_name || 'An AI client',
      logoUri: client.logo_uri || null,
      siteName: site?.name || 'your account',
      effectivePermissionLevel,
      capabilities: CAPABILITY_COPY[effectivePermissionLevel] ? [CAPABILITY_COPY[effectivePermissionLevel]] : [],
    });
  } catch (e) { next(e); }
});

router.post('/oauth/authorize/decision', async (req, res, next) => {
  try {
    const { approved, client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, state, scope, resource } = req.body || {};
    if (!clientId || !redirectUri || !codeChallenge) {
      return res.status(400).json({ error: 'client_id, redirect_uri, and code_challenge are required.' });
    }

    const client = await getClientById(String(clientId));
    if (!client) return res.status(404).json({ error: 'Unknown OAuth client.' });
    if (!client.redirect_uris.some((registered) => redirectUriMatches(String(redirectUri), registered))) {
      return res.status(400).json({ error: 'redirect_uri is not registered for this client.' });
    }

    if (!approved) {
      const denied = new URL(String(redirectUri));
      denied.searchParams.set('error', 'access_denied');
      if (state) denied.searchParams.set('state', String(state));
      return res.json({ redirectTo: denied.href });
    }

    const effectivePermissionLevel = await computeEffectivePermissionLevel(req.siteId, scopesFromParam(scope));

    const code = await createAuthorizationCode({
      clientId: client.client_id,
      siteId: req.siteId,
      userId: req.userId,
      redirectUri: String(redirectUri),
      codeChallenge: String(codeChallenge),
      // The GRANTED scope, not the client's raw request — RFC 6749 §5.1
      // requires the token response's scope to reflect what was actually
      // issued when it differs from what was asked for (e.g. scope=automation
      // requested against a site capped at read_only must not come back
      // labeled "automation just because that's what the client typed).
      scope: effectivePermissionLevel,
      permissionLevel: effectivePermissionLevel,
      resource: typeof resource === 'string' ? resource : undefined,
    });

    const approvedUrl = new URL(String(redirectUri));
    approvedUrl.searchParams.set('code', code);
    if (state) approvedUrl.searchParams.set('state', String(state));
    res.json({ redirectTo: approvedUrl.href });
  } catch (e) { next(e); }
});

export default router;
