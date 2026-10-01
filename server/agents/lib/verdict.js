// One shared vocabulary for "did this detector actually PROVE the defect?"
//
// Detectors kept asserting negatives from signals that cannot fully observe
// real state — a bare fetch() that bot protection blocks, a network blip, a
// GSC snapshot that lags a fix already live — and "I could not confirm it
// works" got reported as "it is broken". Each instance was patched locally
// (site-trackers.js, then the link/alt/canonical detectors). This module is
// the general rule so a new detector does not have to rediscover it:
//
//   confirmed     — an observation that can only be explained by the defect
//                   (a clean 404/410, a missing attribute in fetched HTML).
//                   The only verdict that may become a draft.
//   refuted       — the check ran and the defect is NOT there.
//   unverifiable  — the check could not observe the thing (timeout, network
//                   error, 403/429/5xx after a browser-UA retry). Never
//                   asserted, never auto-eligible; surfaced only as a count.
//
// A finding with no `verification` is legacy and passes through unchanged —
// opting in is per detector, enforcement is in one place
// (recommendations.js's buildRecommendations via isAssertable).

export const VERDICT = Object.freeze({
  CONFIRMED: 'confirmed',
  REFUTED: 'refuted',
  UNVERIFIABLE: 'unverifiable',
});

export function makeVerification(verdict, method, reason = null) {
  if (!Object.values(VERDICT).includes(verdict)) throw new Error(`unknown verdict: ${verdict}`);
  return { verdict, method, reason };
}

// Only a confirmed verdict (or no verdict at all, i.e. a legacy detector that
// has not opted in) may produce a recommendation.
export function isAssertable(finding) {
  const v = finding?.verification?.verdict;
  return v == null || v === VERDICT.CONFIRMED;
}

// Statuses that prove a link is dead. Everything else >= 400 is ambiguous:
// 401/403/429 are access/rate decisions, 5xx is the target's own transient
// state — none says the destination is gone.
const DEFINITIVE_DEAD_STATUSES = new Set([404, 410]);

// Classifies one result from followRedirectsWithRetry (+ optional
// softNotFound). An error with no HTTP status (timeout, network error) is
// NEVER confirmed: confirmed live 2026-09-30, a target failed both the normal
// and the browser-UA attempt with 'network error' and answered 200 minutes
// later — a shared footer link flagged this way is asserted dead on every page
// that carries it.
export function classifyLinkProbe(r) {
  if (r.unverifiable) {
    return makeVerification(VERDICT.UNVERIFIABLE, 'http-probe', 'target blocks automated requests under every user agent tried');
  }
  if (r.error === 'invalid URL') {
    return makeVerification(VERDICT.CONFIRMED, 'http-probe', 'href is not a valid URL');
  }
  if (r.error) {
    return makeVerification(VERDICT.UNVERIFIABLE, 'http-probe', `request failed (${r.error}) with no HTTP status to prove the link dead`);
  }
  if (r.softNotFound) {
    return makeVerification(VERDICT.CONFIRMED, 'soft-404-fingerprint', 'serves the site\'s own nonexistent-page fallback');
  }
  const s = r.finalStatus;
  if (s != null && DEFINITIVE_DEAD_STATUSES.has(s)) {
    return makeVerification(VERDICT.CONFIRMED, 'http-probe', `HTTP ${s}`);
  }
  if (s != null && s >= 400) {
    return makeVerification(VERDICT.UNVERIFIABLE, 'http-probe', `HTTP ${s} is not proof the destination is gone`);
  }
  return makeVerification(VERDICT.REFUTED, 'http-probe', s == null ? 'no failure observed' : `HTTP ${s}`);
}
