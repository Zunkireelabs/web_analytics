import { google } from 'googleapis';
import { randomBytes } from 'node:crypto';

// "Connect with Google": the person is sent to Google's own consent screen, signs in
// with THEIR Google account, and approves read access to their Search Console and
// Analytics. Google sends them back with a one-time code, which this exchanges for a
// refresh token that the project then keeps (server/auth/project-google.js).
//
// Uses a Google "Web application" OAuth client: GOOGLE_CONNECT_CLIENT_ID / _SECRET, or the app's
// GOOGLE_OAUTH_* pair when that one is itself a web client. It is kept separate because the shared platform
// token was minted by a Desktop client (get-oauth-token.js), and a Desktop client cannot have a web
// callback; swapping the shared pair would also invalidate that platform token. The callback address must
// be registered on this client in Google Cloud ("Authorised redirect URIs"); Google refuses any address
// that is not, which is also what stops a crafted link from sending the code anywhere else.

// Search Console is the same scope the app already asks for (the technical agent
// resubmits sitemaps, which needs write); Analytics is read-only. `openid email` only
// tells us WHICH Google account connected, to show "Connected as …".
export const CONNECT_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/analytics.readonly',
  'openid',
  'email',
];
// Without these two nothing useful can be read; Google lets a person untick scopes
// on the consent screen, so what came back is checked rather than assumed.
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/analytics.readonly',
];

export class GoogleConnectError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// The client the connect flow (and every refresh of a token it minted) must use: a refresh token only works
// with the client that issued it.
export const connectClientCreds = (env = process.env) => ({
  id: env.GOOGLE_CONNECT_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID,
  secret: env.GOOGLE_CONNECT_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET,
});

export const googleConnectConfigured = () => { const c = connectClientCreds(); return Boolean(c.id && c.secret); };

// The address Google sends the person back to. An explicit setting wins (needed when the
// app sits behind a proxy that hides its public address); otherwise it is built from the
// address the person is actually using.
export const redirectUriFor = (origin) => process.env.GOOGLE_OAUTH_REDIRECT_URI || `${origin}/api/google/callback`;

const clientFor = (redirectUri) => new google.auth.OAuth2(
  connectClientCreds().id, connectClientCreds().secret, redirectUri);

export const newConnectNonce = () => randomBytes(24).toString('base64url');

export function buildConsentUrl({ redirectUri, state, loginHint }) {
  if (!googleConnectConfigured()) throw new GoogleConnectError('not_configured', 'Google sign-in is not set up on this server yet.');
  return clientFor(redirectUri).generateAuthUrl({
    access_type: 'offline',   // we need a refresh token, not just a one-hour access token
    prompt: 'consent',        // and Google only issues one when consent is shown again
    scope: CONNECT_SCOPES,
    state,
    include_granted_scopes: false, // ask for exactly these, not whatever the account granted before
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
}

// One-time code -> the refresh token, the Google account's email, and what was granted.
export async function exchangeCode({ code, redirectUri }) {
  const client = clientFor(redirectUri);
  let tokens;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (err) {
    throw new GoogleConnectError('exchange_failed', `Google did not accept the sign-in (${err?.response?.data?.error || err.message}).`);
  }
  const granted = String(tokens.scope || '').split(/\s+/).filter(Boolean);
  const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) throw new GoogleConnectError('missing_scopes', 'Search Console and Analytics access both need to be allowed on the Google screen.');
  if (!tokens.refresh_token) throw new GoogleConnectError('no_refresh_token', 'Google did not return a long-lived sign-in. Try again and approve the screen in full.');

  let email = null;
  try {
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: connectClientCreds().id });
    email = ticket.getPayload()?.email || null;
  } catch { /* the email is for display only; the connection is valid without it */ }

  return { refreshToken: tokens.refresh_token, email, scopes: granted.join(' ') };
}

// "Continue with Google" on the get-started and sign-in pages: only WHO the person is, no Search Console or
// Analytics access (that is asked later, per project, by the connect flow above). Uses the same web client and
// the same registered callback address, so nothing new has to be registered in Google Cloud.
export function buildSignInUrl({ redirectUri, state }) {
  if (!googleConnectConfigured()) throw new GoogleConnectError('not_configured', 'Google sign-in is not set up on this server yet.');
  return clientFor(redirectUri).generateAuthUrl({ scope: ['openid', 'email', 'profile'], state, prompt: 'select_account', include_granted_scopes: false });
}

// One-time code -> the Google account's email, only when Google itself says that address is verified.
export async function exchangeSignInCode({ code, redirectUri }) {
  const client = clientFor(redirectUri);
  let tokens;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (err) {
    throw new GoogleConnectError('exchange_failed', `Google did not accept the sign-in (${err?.response?.data?.error || err.message}).`);
  }
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: connectClientCreds().id });
  const payload = ticket.getPayload() || {};
  if (!payload.email || payload.email_verified !== true) throw new GoogleConnectError('unverified', 'Google has not verified that email address.');
  return { email: String(payload.email).trim().toLowerCase(), name: payload.name || null };
}
