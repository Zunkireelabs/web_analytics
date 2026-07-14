import { getSearchConsole } from '../auth/google.js';

export const meta = {
  id: 'google-oauth',
  label: 'Google OAuth',
  category: 'google',
  description: 'Shared refresh-token connection used for Search Console, GA4, and Docs API access across all sites.',
};

// Auth-shaped Google API error signatures vs. everything else (network
// blips, rate limits, transient 5xx) — only auth-shaped failures should ever
// report a recovery action telling someone to re-run the OAuth consent flow.
const AUTH_ERROR_PATTERNS = /invalid_grant|invalid_client|unauthorized_client|token has been expired or revoked|invalid_rapt|deleted_client/i;

export function isGoogleAuthError(err) {
  const status = err?.code ?? err?.response?.status;
  const googleError = err?.response?.data?.error;
  const message = err?.message || '';
  if (status === 401) return true;
  if (googleError && AUTH_ERROR_PATTERNS.test(String(googleError))) return true;
  return AUTH_ERROR_PATTERNS.test(message);
}

function describeError(err) {
  return err?.response?.data?.error_description || err?.response?.data?.error || err?.message || String(err);
}

// Live, read-only diagnostic: exchanges the refresh token for an access
// token and makes one trivial Search Console call. Shared by the on-demand
// "Test connection" route and — via isGoogleAuthError — the job pipeline's
// organic-failure recording, so both paths classify errors identically.
export async function check(site) {
  try {
    const sc = await getSearchConsole(site);
    const res = await sc.sites.list();
    return {
      ok: true,
      authStatus: 'valid',
      errorMessage: null,
      recoveryAction: null,
      detail: { siteCount: res.data.siteEntry?.length ?? 0 },
    };
  } catch (err) {
    const authError = isGoogleAuthError(err);
    return {
      ok: false,
      authStatus: authError ? 'revoked' : 'unknown',
      errorMessage: describeError(err),
      recoveryAction: authError
        ? 'Run `npm run get-token` to re-authenticate the shared Google OAuth connection.'
        : null,
    };
  }
}
