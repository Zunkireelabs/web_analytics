import { classifyFailure } from '../../lib/failure-classification.js';

// Decides what a failure MEANS for the rest of the run: stop everything, or
// set this one thing aside and keep spending the day's budget.
//
// The behaviour this replaces stopped a site's entire run after 5 consecutive
// failures of ANY kind. That threshold was written for a systemic fault (a
// revoked token, a moved default branch) where every later attempt is doomed
// too — but it fired just as readily on a cluster of unrelated per-item
// problems, and the real backlog clusters hard: the reference site had 15+
// consecutive "X has no services.Y entry in src/_data/locations.js" items,
// which sort together because they share a generator and a priority. Five of
// those in a row killed a 60-item day at item five, leaving ~55 slots of
// perfectly shippable work untouched.
//
// Why this can't just call classifyFailure and be done: that classifier was
// built for the design-agent job pipeline and its discriminating rules need
// {stage, exitCode, timedOut}, none of which the shipping loop has. Called
// from there it can distinguish exactly one thing — GITHUB_RATE_LIMITED —
// and returns UNCLASSIFIED_FAILURE for a revoked token and a malformed draft
// alike. So this module adds the positive systemic signals that path can
// actually observe, and defers to classifyFailure where it is authoritative.

export const FAILURE_KIND = {
  RATE_LIMIT: 'rate-limit',   // neither fault nor refusal — a statement about timing
  SYSTEMIC: 'systemic',       // every remaining item shares this fault; stopping is correct
  ITEM: 'item',               // this one item; the next item is unaffected
};

// Real, observable systemic signatures from the shipping path. Matched on
// message text only as a LAST resort (after structured fields), because
// matching prose is how a classifier quietly stops recognising the thing it
// was written for — lib/failure-classification.js says so itself.
const SYSTEMIC_MESSAGE_PATTERNS = [
  /\bbad credentials\b/i,           // GitHub 401: the PAT is dead
  /\brequires authentication\b/i,
  /\btoken .*(expired|revoked)\b/i,
  /\bnot accessible by integration\b/i,
  /\brepository not found\b/i,       // repo deleted, renamed, or access removed
  /\bECONNREFUSED\b/,                // database or an internal service is down
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bterminating connection\b/i,     // Postgres shutting down
  /\btoo many connections\b/i,
];

// Postgres/driver error codes that mean the database itself is unavailable —
// no per-item retry can help, and continuing burns a generation call each.
const SYSTEMIC_DB_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
]);

/**
 * @param err   the thrown error
 * @param opts  { isRefusal } — a refusal is decided by the caller (it owns
 *              the generator contract) and is never systemic by definition.
 * @returns { kind, reason }
 */
export function classifyShipFailure(err, { isRefusal = false } = {}) {
  const classified = classifyFailure({ stage: 'github_api', err });
  if (classified.errorCode === 'GITHUB_RATE_LIMITED') {
    return { kind: FAILURE_KIND.RATE_LIMIT, reason: 'github rate limit' };
  }

  // A refusal is the no-fabrication policy working. It says nothing about
  // system health, so it can never be systemic — checked before the
  // signatures below so a refusal whose text happens to mention a repo or a
  // connection can't be misread as infrastructure.
  if (isRefusal) return { kind: FAILURE_KIND.ITEM, reason: 'refusal' };

  // classifyFailure is authoritative where it CAN decide: it already marks
  // deployment/external-service classes as infrastructure. Its CLIENT_REPO
  // class (a dead/inaccessible repo) exists too, but is gated on
  // `stage === 'repo_checkout'` and, at that stage, treats ANY non-transient
  // error as repo trouble — accurate for the design-agent pipeline that
  // stage was written for, far too broad to reuse here (it would
  // misclassify an ordinary "no sections to expand" content failure as
  // systemic). So a dead/inaccessible repo is instead caught below by this
  // module's own explicit signatures (SYSTEMIC_MESSAGE_PATTERNS includes
  // "repository not found" and "not accessible by integration"), scoped to
  // this call site instead of borrowing a rule shaped for a different one.
  if (classified.infrastructure === true) {
    return { kind: FAILURE_KIND.SYSTEMIC, reason: `infrastructure: ${classified.errorCode}` };
  }

  if (err?.code && SYSTEMIC_DB_CODES.has(String(err.code))) {
    return { kind: FAILURE_KIND.SYSTEMIC, reason: `database unavailable (${err.code})` };
  }
  // GitHub auth failures arrive as a 401/403 that is NOT a rate limit (the
  // rate-limit case already returned above).
  if (err?.status === 401) {
    return { kind: FAILURE_KIND.SYSTEMIC, reason: 'github authentication failed (401)' };
  }

  const message = String(err?.message || '');
  for (const pattern of SYSTEMIC_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return { kind: FAILURE_KIND.SYSTEMIC, reason: `systemic signature: ${pattern.source}` };
    }
  }

  return { kind: FAILURE_KIND.ITEM, reason: classified.errorCode || 'item failure' };
}

// How many CONSECUTIVE systemic failures end the run. Lower than the old
// all-purpose limit of 5 because this counter now only ever sees genuine
// infrastructure faults, where the second occurrence is already strong
// evidence and a third is conclusive. One alone is not enough: a single
// transient socket error mid-run shouldn't cost the day.
export const SYSTEMIC_FAILURE_LIMIT = 3;

// How many failures within one FAMILY quarantine that family for the rest of
// the run. A family is (generator + normalized failure reason) — the shape
// that repeats. Two is right: the first can be bad luck on one page, the
// second establishes the pattern, and every later member would spend an LLM
// generation call to reach the same error.
export const FAMILY_FAILURE_LIMIT = 2;

// Collapses an error message to the stable part that identifies the KIND of
// problem, so "pokhara has no services.aeo-seo entry in src/_data/locations.js"
// and "lalitpur has no services.ai-development entry in src/_data/locations.js"
// land in one family instead of looking like two unrelated failures.
export function failureFamilyKey(generatorId, err) {
  const message = String(err?.message || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/"[^"]*"/g, '<q>')
    .replace(/\b[\w.-]+\.(?:js|njk|md|html|jsx|ts|json)\b/g, '<file>')
    .replace(/\d+/g, '<n>')
    .slice(0, 120);
  return `${generatorId}::${message}`;
}
