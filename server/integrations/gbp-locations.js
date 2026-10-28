import { google } from 'googleapis';
import { connectClientCreds, googleConnectConfigured, GoogleConnectError } from './google-connect.js';

// "Which of my Business Profiles is this project?": the person signs in with the Google account that manages their
// profiles, approves read access to them, and picks one from the list, the way Search Console and Analytics are
// chosen. Deliberately NOT part of the main Connect Google consent:
//   - the main connection (Search Console + Analytics) is untouched and still asks for exactly what it did,
//   - the profiles can belong to a DIFFERENT Google account than the one that holds Search Console, so this never
//     overwrites that connection,
//   - nothing long-lived is kept: the list is read once, right after consent, with a short-lived access token that is
//     thrown away. Only the chosen profile's Maps link is stored (sites.gbp_url).
//
// Reads go through two Google APIs that Google gates per Cloud project: "My Business Account Management API" and
// "My Business Business Information API". Until both are enabled AND Google has approved the project for them,
// Google answers 403/429; that is reported as a plain "not available yet" and the paste-a-link path stays.
export const BUSINESS_SCOPES = ['https://www.googleapis.com/auth/business.manage', 'openid', 'email'];
const ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20';
const LOCATIONS_URL = (account) => `https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations?pageSize=100&readMask=${encodeURIComponent('name,title,storefrontAddress,metadata')}`;
const MAX_ACCOUNTS = 5;

const clientFor = (redirectUri) => new google.auth.OAuth2(connectClientCreds().id, connectClientCreds().secret, redirectUri);

export function buildBusinessConsentUrl({ redirectUri, state, loginHint }) {
  if (!googleConnectConfigured()) throw new GoogleConnectError('not_configured', 'Google sign-in is not set up on this server yet.');
  return clientFor(redirectUri).generateAuthUrl({
    access_type: 'online',          // one read right now; no long-lived token is wanted or kept
    prompt: 'select_account',       // the profiles may be under another Google account than the one already used
    scope: BUSINESS_SCOPES,
    state,
    include_granted_scopes: false,  // exactly the Business Profile permission, nothing more
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
}

// One-time code -> a short-lived access token and the account's email. Throws GoogleConnectError for the cases the
// person can act on (they unticked the permission).
export async function exchangeBusinessCode({ code, redirectUri }) {
  let tokens;
  try {
    ({ tokens } = await clientFor(redirectUri).getToken(code));
  } catch (err) {
    throw new GoogleConnectError('exchange_failed', `Google did not accept the sign-in (${err?.response?.data?.error || err.message}).`);
  }
  const granted = String(tokens.scope || '').split(/\s+/).filter(Boolean);
  if (!granted.includes('https://www.googleapis.com/auth/business.manage')) {
    throw new GoogleConnectError('missing_scopes', 'Access to your Business Profiles needs to be allowed on the Google screen.');
  }
  let email = null;
  try { email = JSON.parse(Buffer.from(String(tokens.id_token || '').split('.')[1] || '', 'base64url').toString()).email || null; } catch { /* the email only labels the account */ }
  return { accessToken: tokens.access_token, email };
}

// Why Google refused the list, in the two words the screen needs. 'not_available' is "this server's Google project
// is not approved for Business Profile reads yet"; 'denied' is "this account has no access".
export function classifyGbpError(status, body) {
  const text = JSON.stringify(body || {}).toLowerCase();
  if (status === 429 || /rate_limit_exceeded|quota|resource_exhausted/.test(text)) return 'not_available';
  if (status === 403 && /service_disabled|has not been used|api has not been enabled|accessnotconfigured/.test(text)) return 'not_available';
  if (status === 401 || status === 403) return 'denied';
  return 'failed';
}

const oneLine = (a) => [...(a?.addressLines || []), a?.locality, a?.postalCode].filter(Boolean).join(', ');

// Pure: one account's locations response in, the fields the screen shows out.
export function mapLocations(response) {
  return (Array.isArray(response?.locations) ? response.locations : [])
    .filter((l) => l?.title && l?.metadata?.mapsUri)
    .map((l) => ({
      id: l.name || l.metadata.placeId || l.metadata.mapsUri,
      name: l.title,
      address: oneLine(l.storefrontAddress),
      mapsUrl: l.metadata.mapsUri,
      placeId: l.metadata.placeId || null,
      verified: l.metadata.hasVoiceOfMerchant === true,
    }));
}

export async function listBusinessLocations(accessToken, { fetchImpl = fetch } = {}) {
  const call = async (url) => {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) });
    let body = null;
    try { body = await res.json(); } catch { /* an empty body is fine */ }
    if (!res.ok) {
      // What Google actually said, kept on the error so the server log can tell "API not enabled" from "not approved yet".
      const detail = body?.error?.details?.[0]?.reason || body?.error?.status || '';
      throw Object.assign(new Error(`Google answered ${res.status}${detail ? ` ${detail}` : ''}: ${String(body?.error?.message || '').slice(0, 200)}`), { gbp: classifyGbpError(res.status, body), status: res.status, detail });
    }
    return body;
  };
  const accounts = ((await call(ACCOUNTS_URL)).accounts || []).slice(0, MAX_ACCOUNTS);
  const lists = await Promise.all(accounts.map((a) => call(LOCATIONS_URL(a.name)).then(mapLocations)));
  const seen = new Set();
  return lists.flat().filter((l) => (seen.has(l.mapsUrl) ? false : seen.add(l.mapsUrl)));
}
