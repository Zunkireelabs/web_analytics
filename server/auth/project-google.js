import { google } from 'googleapis';
import { query } from '../db.js';
import { decryptSecret } from '../lib/secret-box.js';
import { connectClientCreds } from '../integrations/google-connect.js';
import { isGoogleAuthError } from '../integrations/google-oauth.js';
import { markGoogleConnectionStatus } from '../store/project-google.js';

// Thrown when a project HAS its own Google connection but it cannot be used. It is
// deliberately an error, never a null: null means "no connection of its own, use the
// platform's", and silently doing that for a client whose access is gone would read
// with an identity they never granted (or fail with a misleading "no access").
export class ProjectGoogleAuthError extends Error {
  constructor(siteId, reason) {
    super('Google connection expired. Reconnect Google to keep this project\'s data up to date.');
    this.name = 'ProjectGoogleAuthError';
    this.code = 'GOOGLE_RECONNECT';
    this.status = 409;
    this.userFacing = true;
    this.projectGoogle = true; // per-project: must never be recorded on the shared platform check
    this.siteId = siteId;
    this.reason = reason;
  }
}

// A project's OWN Google access: the refresh token of the account that clicked
// "Connect with Google" (migration 200). When a project has one, its Search Console
// and Analytics reads use it INSTEAD of the shared platform account, so the agent can
// only see what that person can see — and the shared account never needs to be added
// as a user on their property.
//
// Returns an OAuth2 client, or null when the project has no connection of its own,
// in which case callers fall through to the existing shared-credentials path untouched.
// A project that HAS a connection which is expired or unreadable gets a thrown
// ProjectGoogleAuthError instead — never the shared account.
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

export function oauthClientFor(refreshToken, siteId = null, version = null) {
  // A project's refresh token was issued by the connect client, so it is refreshed with that same client.
  const { id, secret } = connectClientCreds();
  const client = new google.auth.OAuth2(id, secret);
  client.setCredentials({ refresh_token: refreshToken });
  if (siteId != null) {
    // Google refusing the refresh token (revoked, expired, access removed) is the moment
    // the connection stops being usable: record it for THIS project only, drop the cached
    // client, and fail every later read with a reconnect error until it is redone.
    const refresh = client.refreshTokenNoCache.bind(client);
    client.refreshTokenNoCache = async (token) => {
      try {
        return await refresh(token);
      } catch (err) {
        if (isGoogleAuthError(err)) {
          const why = err.response?.data?.error_description || err.response?.data?.error || err.message;
          await markGoogleConnectionStatus(siteId, 'expired', why, { version }).catch(() => {});
          cache.delete(Number(siteId));
          throw Object.assign(new ProjectGoogleAuthError(siteId, why), { cause: err });
        }
        throw err;
      }
    };
  }
  return client;
}

export async function getProjectGoogleAuth(site) {
  const siteId = Number(site?.id);
  if (!siteId) return null;
  const hit = cache.get(siteId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = null;
  const { rows } = await query('SELECT refresh_token_enc, status, status_error, updated_at FROM project_google_connections WHERE site_id = $1', [siteId]);
  if (rows[0]) {
    // Already known to be dead: do not even try, and do not fall back to anyone else's access.
    if (rows[0].status !== 'ok') throw new ProjectGoogleAuthError(siteId, rows[0].status_error || rows[0].status);
    try {
      value = oauthClientFor(decryptSecret(rows[0].refresh_token_enc), siteId, rows[0].updated_at);
    } catch (err) {
      console.error(`[project-google] site ${siteId}: stored Google connection could not be used: ${err.message}`);
      await markGoogleConnectionStatus(siteId, 'unreadable', err.message).catch(() => {});
      throw new ProjectGoogleAuthError(siteId, 'unreadable');
    }
  }
  cache.set(siteId, { at: Date.now(), value });
  return value;
}
