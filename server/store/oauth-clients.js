import { query } from '../db.js';

// RFC 7591 Dynamic Client Registration store — backs the OAuthRegisteredClientsStore
// interface the MCP SDK's authorizationHandler/tokenHandler/clientRegistrationHandler
// expect (see server/mcp/oauth-provider.js).
//
// Confidential clients (token_endpoint_auth_method='client_secret_post') are
// deliberately not supported: the SDK's own authenticateClient middleware
// compares an incoming client_secret against client.client_secret in
// *plaintext*, which is incompatible with storing only a SHA-256 hash (the
// discipline every other secret in this codebase follows, see
// server/store/api-tokens.js). Since the actual clients here — Claude.ai/
// ChatGPT remote connectors — register as public clients with no secret at
// all, every registration is forced to 'none' regardless of what was
// requested, so this mismatch never has a chance to matter.

export async function registerClient(client) {
  const { client_id, client_name, logo_uri, redirect_uris, grant_types } = client;

  const { rows } = await query(
    `INSERT INTO oauth_clients (client_id, client_name, logo_uri, redirect_uris, token_endpoint_auth_method, grant_types)
     VALUES ($1, $2, $3, $4, 'none', COALESCE($5, ARRAY['authorization_code','refresh_token']))
     RETURNING *`,
    [client_id, client_name || null, logo_uri || null, redirect_uris, grant_types || null]
  );
  return toClientInformationFull(rows[0]);
}

export async function getClientById(clientId) {
  const { rows } = await query(`SELECT * FROM oauth_clients WHERE client_id = $1`, [clientId]);
  if (!rows.length) return undefined;
  return toClientInformationFull(rows[0]);
}

function toClientInformationFull(row) {
  return {
    client_id: row.client_id,
    // client_secret intentionally omitted — always undefined, since every
    // client is public (see note above). Leaving this key present-but-
    // undefined (rather than never setting it) documents that omission was
    // deliberate, not forgotten.
    client_secret: undefined,
    client_secret_expires_at: undefined,
    client_name: row.client_name || undefined,
    logo_uri: row.logo_uri || undefined,
    redirect_uris: row.redirect_uris,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    grant_types: row.grant_types,
  };
}
