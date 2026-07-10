import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

// Scopes: read-only for the data APIs, plus Docs write for the weekly report doc.
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',   // Search Console
  'https://www.googleapis.com/auth/analytics.readonly',    // GA4 Data API
  'https://www.googleapis.com/auth/documents',             // Google Docs (weekly report)
];

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_CREDENTIALS_ROOT = join(here, '..', '..', 'secrets', 'clients');

// Per-client credentials, one optional file per site: secrets/clients/<site.id>/service-account.json.
// Returns the absolute path if that site has its own file, else null — the null case is what makes
// every caller below fall through to the existing shared-credentials logic, unchanged.
function getSiteCredentialsPath(site) {
  if (!site?.id) return null;
  const p = join(CLIENT_CREDENTIALS_ROOT, String(site.id), 'service-account.json');
  return existsSync(p) ? p : null;
}

// Returns a google-auth-library auth client.
// If `site` has its own credentials file (secrets/clients/<site.id>/service-account.json), it is
// used exclusively for that site. Otherwise, falls back to the shared app-wide credentials:
// primary path: OAuth2 refresh token (the three GOOGLE_OAUTH_* env vars); fallback path: service
// account via GOOGLE_APPLICATION_CREDENTIALS.
export function getGoogleAuth(site) {
  const siteCredPath = getSiteCredentialsPath(site);
  if (siteCredPath) {
    return new GoogleAuth({ scopes: SCOPES, keyFilename: siteCredPath });
  }

  const {
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REFRESH_TOKEN,
  } = process.env;

  if (GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
    return oauth2;
  }

  // Service account (default). GOOGLE_APPLICATION_CREDENTIALS points at the JSON key.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'No Google credentials found. Set GOOGLE_APPLICATION_CREDENTIALS (service account) ' +
      'or the GOOGLE_OAUTH_* variables in .env.'
    );
  }
  return new GoogleAuth({ scopes: SCOPES });
}

// Search Console API client, scoped to `site`'s own credentials if it has any.
export async function getSearchConsole(site) {
  const auth = getGoogleAuth(site);
  return google.searchconsole({ version: 'v1', auth });
}

// Google Docs API client, scoped to `site`'s own credentials if it has any.
export function getDocs(site) {
  const auth = getGoogleAuth(site);
  return google.docs({ version: 'v1', auth });
}

// Returns credentials usable by @google-analytics/data's BetaAnalyticsDataClient, scoped to
// `site`'s own credentials if it has any. Falls back to the same shared-credentials logic as
// getGoogleAuth() above (OAuth2 authClient, or {} so the GA4 client reads
// GOOGLE_APPLICATION_CREDENTIALS itself for the service-account path).
export function getGa4ClientOptions(site) {
  const siteCredPath = getSiteCredentialsPath(site);
  if (siteCredPath) return { keyFilename: siteCredPath };

  const {
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REFRESH_TOKEN,
  } = process.env;

  if (GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
    return { authClient: oauth2 };
  }
  return {};
}
