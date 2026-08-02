import { z } from 'zod';
import { createApiToken, listApiTokensForSite, revokeApiToken } from '../../server/store/api-tokens.js';
import { PERMISSION_LEVELS, DEFAULT_PERMISSION_LEVEL } from '../permissions.js';
import { jsonResult, requireLevel, withErrorHandling } from './shared.js';

// "Admin" tier tools — the top tier: managing this site's own MCP bearer
// tokens. Deliberately self-referential and unchecked beyond the tier gate
// itself: an AI client holding an `admin` token can mint more tokens for
// this same site — including more `admin` tokens — with no human confirming
// each one. That's not a gap here; it mirrors server/routes/mcp-tokens.js's
// HTTP route exactly (a session-authed human already has this same power
// today), and the Settings UI's token-creation copy already warns clients
// about it in plain language before they ever mint an Admin token.
export function registerAdminTools(server, siteId, permissionLevel, tokenId) {
  server.registerTool('list_api_tokens', {
    description: "Lists this site's MCP bearer tokens — metadata only (label, permission level, prefix, last used, revoked). Never returns a usable secret.",
    inputSchema: {},
  }, withErrorHandling('list_api_tokens', async () => {
    const denied = requireLevel(permissionLevel, 'admin'); if (denied) return denied;
    return jsonResult(await listApiTokensForSite(siteId));
  }));

  server.registerTool('create_api_token', {
    description: 'Mints a new MCP bearer token for this site, scoped to a chosen permission level. The plaintext token is returned once, in this response only — it is never stored or retrievable again.',
    inputSchema: { label: z.string().optional(), permissionLevel: z.enum(PERMISSION_LEVELS).optional() },
  }, withErrorHandling('create_api_token', async ({ label, permissionLevel: newTokenLevel }) => {
    const denied = requireLevel(permissionLevel, 'admin'); if (denied) return denied;
    const created = await createApiToken(siteId, {
      label: label || null, createdBy: null, permissionLevel: newTokenLevel || DEFAULT_PERMISSION_LEVEL,
      createdViaTokenId: tokenId,
    });
    return jsonResult(created);
  }));

  server.registerTool('revoke_api_token', {
    description: "Revokes one of this site's MCP bearer tokens immediately — any client using it loses access with no propagation delay.",
    inputSchema: { id: z.number().int() },
  }, withErrorHandling('revoke_api_token', async ({ id }) => {
    const denied = requireLevel(permissionLevel, 'admin'); if (denied) return denied;
    const ok = await revokeApiToken(siteId, id);
    if (!ok) return { isError: true, content: [{ type: 'text', text: 'Token not found.' }] };
    return jsonResult({ revoked: true });
  }));
}
