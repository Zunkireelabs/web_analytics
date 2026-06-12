import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import 'dotenv/config';

// Scopes: read-only for the data APIs, plus Docs write for the weekly report doc.
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',   // Search Console
  'https://www.googleapis.com/auth/analytics.readonly',    // GA4 Data API
  'https://www.googleapis.com/auth/documents',             // Google Docs (weekly report)
];

// Returns a google-auth-library auth client.
// Primary path: service account via GOOGLE_APPLICATION_CREDENTIALS.
// Fallback path: OAuth2 refresh token (set the three GOOGLE_OAUTH_* env vars).
export function getGoogleAuth() {
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

// Search Console API client.
export async function getSearchConsole() {
  const auth = getGoogleAuth();
  return google.searchconsole({ version: 'v1', auth });
}

// Google Docs API client (used for the weekly report document).
export function getDocs() {
  const auth = getGoogleAuth();
  return google.docs({ version: 'v1', auth });
}

// Returns credentials usable by @google-analytics/data's BetaAnalyticsDataClient.
// The GA4 client reads GOOGLE_APPLICATION_CREDENTIALS itself for the service-account path;
// for OAuth we hand it an authClient.
export function getGa4ClientOptions() {
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
  // Service account: BetaAnalyticsDataClient picks up GOOGLE_APPLICATION_CREDENTIALS automatically.
  return {};
}
