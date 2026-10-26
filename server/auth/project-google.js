import { google } from 'googleapis';
import { query } from '../db.js';
import { decryptSecret } from '../lib/secret-box.js';

// A project's OWN Google access: the refresh token of the account that clicked
// "Connect with Google" (migration 200). When a project has one, its Search Console
// and Analytics reads use it INSTEAD of the shared platform account, so the agent can
// only see what that person can see — and the shared account never needs to be added
// as a user on their property.
//
// Returns an OAuth2 client, or null when the project has no connection of its own
// (every project today), in which case callers fall through to the existing
// shared-credentials path untouched.
//
// Cached for a minute per site: ingestion asks for credentials many times per run,
// and a connection changes only when someone clicks Connect or Disconnect (both of
// which call forgetProjectGoogleAuth, so the change is seen at once by this process).
const TTL_MS = 60_000;
const cache = new Map(); // siteId -> { at, value }

export function forgetProjectGoogleAuth(siteId) {
  if (siteId == null) cache.clear();
  else cache.delete(Number(siteId));
}

export function oauthClientFor(refreshToken) {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET } = process.env;
  const client = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export async function getProjectGoogleAuth(site) {
  const siteId = Number(site?.id);
  if (!siteId) return null;
  const hit = cache.get(siteId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = null;
  try {
    const { rows } = await query('SELECT refresh_token_enc FROM project_google_connections WHERE site_id = $1', [siteId]);
    if (rows[0]) value = oauthClientFor(decryptSecret(rows[0].refresh_token_enc));
  } catch (err) {
    // A stored connection that cannot be read (key changed or missing, row damaged) must
    // be LOUD, not a silent switch to someone else's credentials: log it, and fall back
    // to the shared path, which fails with Google's own "no access" for a property only
    // the client's account could see. Not cached, so it is retried on the next call.
    console.error(`[project-google] site ${siteId}: stored Google connection could not be used: ${err.message}`);
    return null;
  }
  cache.set(siteId, { at: Date.now(), value });
  return value;
}
