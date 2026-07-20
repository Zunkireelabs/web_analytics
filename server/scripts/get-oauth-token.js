import 'dotenv/config';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

// One-time helper: runs the OAuth consent flow using YOUR Google account
// (which already has GSC + GA4 access) and writes a long-lived refresh token
// into .env as GOOGLE_OAUTH_REFRESH_TOKEN.
//
// Prereqs in .env:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   (from a "Desktop app" OAuth client)
//
// Run: npm run get-token

const PORT = 3055;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/documents',
];

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '.env');

const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET } = process.env;
if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
  console.error(
    '\nMissing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env.\n' +
    'Create a "Desktop app" OAuth client in Google Cloud Console and paste those two values into .env first.\n'
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, REDIRECT);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',   // ask for a refresh token
  prompt: 'consent',        // force a fresh refresh token every run
  scope: SCOPES,
});

function writeRefreshToken(token) {
  let env = readFileSync(envPath, 'utf8');
  if (/^GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m.test(env)) {
    env = env.replace(/^GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m, `GOOGLE_OAUTH_REFRESH_TOKEN=${token}`);
  } else {
    env += `\nGOOGLE_OAUTH_REFRESH_TOKEN=${token}\n`;
  }
  writeFileSync(envPath, env);
}

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) throw new Error('No refresh_token returned. Re-run (consent forces one).');
    writeRefreshToken(tokens.refresh_token);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>✅ Success!</h2><p>Refresh token saved to .env. You can close this tab and return to the terminal.</p>');
    console.log('\n✅ Refresh token saved to .env (GOOGLE_OAUTH_REFRESH_TOKEN).\n');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>❌ Error</h2><pre>${err.message}</pre>`);
    console.error('\n❌ Token exchange failed:', err.message, '\n');
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 300);
  }
});

server.listen(PORT, () => {
  console.log('\n────────────────────────────────────────────────────────');
  console.log('1) Open this URL in your browser and approve access:\n');
  console.log(authUrl);
  console.log('\n2) After you approve, this will save the token automatically.');
  console.log('────────────────────────────────────────────────────────\n');
});
