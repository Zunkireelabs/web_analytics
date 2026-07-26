import { Router } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { oauthProvider } from '../mcp/oauth-provider.js';
import { PERMISSION_LEVELS } from '../mcp/permissions.js';

// OAuth 2.1 authorization-server surface for onboarded clients connecting
// via ChatGPT/Claude.ai — a second, parallel auth path alongside the manual
// bearer-token flow (server/routes/mcp-tokens.js, unchanged). Mounted at the
// app root (not under /api) since these are OAuth-spec paths, not this
// app's own API — see server/index.js for mount order.
//
// Every handler below is the MCP SDK's own, tested implementation
// (@modelcontextprotocol/sdk/server/auth/handlers/*) — this file only wires
// them to our Postgres-backed provider (server/mcp/oauth-provider.js) and
// adds the two discovery documents the SDK doesn't build a route for itself.
// There is deliberately no /oauth/callback here — that URL belongs to the
// connecting AI client (Claude.ai/ChatGPT's own domain); we only ever
// redirect a browser *to* it, in oauth-provider.js's authorize().
const router = Router();

// Advertised scopes are exactly the OAuth-reachable permission tiers —
// 'admin' is excluded (see migration 061 / oauth_authorization_codes CHECK
// constraints; OAuth can never mint an admin-tier token, regardless of what
// scope a client asks for).
const OAUTH_SCOPES = PERMISSION_LEVELS.filter((level) => level !== 'admin');

function originOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// RFC 8414 — lets an MCP client discover /oauth/authorize, /oauth/token,
// etc. without them being hardcoded into the client. Built by hand (rather
// than the SDK's mcpAuthRouter/createOAuthMetadata convenience wrapper)
// because that wrapper hardcodes paths at the app root as `/authorize`,
// `/token`, etc. — this app's paths are `/oauth/authorize`, `/oauth/token`.
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const origin = originOf(req);
  res.set('Cache-Control', 'no-store');
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: OAUTH_SCOPES,
  });
});

// RFC 9728 — tells an MCP client which authorization server protects
// POST /api/mcp. The MCP transport spec expects this at a path suffixed
// with the protected resource's own path.
router.get('/.well-known/oauth-protected-resource/api/mcp', (req, res) => {
  const origin = originOf(req);
  res.set('Cache-Control', 'no-store');
  res.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
  });
});

router.use('/oauth/authorize', authorizationHandler({ provider: oauthProvider }));
router.use('/oauth/token', tokenHandler({ provider: oauthProvider }));
router.use('/oauth/register', clientRegistrationHandler({
  clientsStore: oauthProvider.clientsStore,
  // Every registered client is public (see server/store/oauth-clients.js) —
  // no client_secret is ever issued, so an expiry window is moot. Explicit
  // 0 (never expires) rather than the SDK's 30-day default, since there is
  // no secret whose expiry this could meaningfully gate.
  clientSecretExpirySeconds: 0,
}));
router.use('/oauth/revoke', revocationHandler({ provider: oauthProvider }));

export default router;
