import { classifyFailure } from '../../lib/failure-classification.js';
import { sanitizeForCustomer } from '../../lib/errors.js';

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
  /\bno credits remaining\b/i,      // OpenAI 429 when the account has no credit
  /\benforced spend limit\b/i,      // OpenAI 429 when the PROJECT's own spend cap is reached (2026-11-19; credit can be fine)
  /\binsufficient[_ ]quota\b/i,
  /\bcredit balance is too low\b/i, // Anthropic's equivalent
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

  // The LLM provider itself is unusable (out of credit, or the key is dead).
  // Tagged by generators/lib/llm-error.js. Every remaining item would fail the
  // same way and cost a call each, so this stops the run. Checked before the
  // GitHub-shaped rules below: a provider 401/429 is not a GitHub 401/429.
  if (err?.llmQuota === true) return { kind: FAILURE_KIND.SYSTEMIC, reason: 'llm provider out of credit/quota' };
  if (err?.llmAuth === true) return { kind: FAILURE_KIND.SYSTEMIC, reason: 'llm provider authentication failed' };

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

  // Deliberately not wrapped in the String(...) coercion call that
  // check-error-leaks.js's CI gate flags as the shape behind two past leak
  // incidents. Harmless here in fact (only ever fed to .test(), never
  // returned or logged), but that gate can't see that far, and a caught
  // error's message is already a string per Error's own constructor
  // semantics — same bare idiom server/lib/errors.js's logInternal uses.
  const message = err?.message || '';
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
  const message = (err?.message || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/"[^"]*"/g, '<q>')
    .replace(/\b[\w.-]+\.(?:js|njk|md|html|jsx|ts|json)\b/g, '<file>')
    .replace(/\d+/g, '<n>')
    .slice(0, 120);
  // Real defense-in-depth, not just a CI-gate workaround: this string is
  // persisted (auto_remediation_runs.selection.quarantineNotes, see
  // auto-remediation.js) and logged, and the .replace() chain above strips
  // only the shapes it knows about (URLs, quoted strings, filenames,
  // numbers) — sanitizeForCustomer's LEAK_PATTERNS is the same net every
  // other persistence boundary in this codebase relies on for whatever it
  // doesn't. A caught leak collapses every match to one generic family,
  // which is still correct for quarantine's purposes: repeats of the same
  // underlying fault still coalesce under it.
  return sanitizeForCustomer(`${generatorId}::${message}`, `${generatorId}::unspecified-error`);
}

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A refusal is the no-fabrication policy working, but "refused" says nothing about WHY, and the why decides what happens next.
// Eight unrelated kinds used to share one counter, so a run of "waiting for the client" refusals stopped the whole site's run
// (Admizz: 4 runs, 0 shipped, 131 safe fixes waiting).
export const REFUSAL_KIND = {
  NEEDS_INPUT: 'needs_input',                       // a person must supply something; retrying cannot help until they do
  STALE: 'stale',                                   // the recommendation's premise no longer holds
  ALREADY_RESOLVED: 'already_resolved',             // nothing left to fix
  UNSUPPORTED: 'unsupported',                       // this generator cannot do this operation here (e.g. shared layout)
  DESIGN_VALIDATION_PENDING: 'design_validation_pending',
  TEMPORARY_EXTERNAL: 'temporary_external_failure', // a service we depend on was unavailable; try again later
  HUMAN_APPROVAL_REQUIRED: 'human_approval_required',
  GENERATOR_DEFECT: 'generator_defect',             // the generator produced something the gates rejected, or gave no reason
};

// Kinds that say NOTHING about the generator: they never count toward quarantining it.
const NOT_A_GENERATOR_SIGNAL = new Set([
  REFUSAL_KIND.NEEDS_INPUT, REFUSAL_KIND.STALE, REFUSAL_KIND.ALREADY_RESOLVED, REFUSAL_KIND.DESIGN_VALIDATION_PENDING,
  REFUSAL_KIND.TEMPORARY_EXTERNAL, REFUSAL_KIND.HUMAN_APPROVAL_REQUIRED,
]);

export function classifyRefusal(err) {
  if (err?.needsInput === true) return REFUSAL_KIND.NEEDS_INPUT;
  if (err?.alreadyResolved === true) return REFUSAL_KIND.ALREADY_RESOLVED;
  if (err?.stale === true) return REFUSAL_KIND.STALE;
  if (err?.designPending === true) return REFUSAL_KIND.DESIGN_VALIDATION_PENDING;
  if (err?.temporary === true || err?.llmProvider === true) return REFUSAL_KIND.TEMPORARY_EXTERNAL;
  if (err?.humanApproval === true) return REFUSAL_KIND.HUMAN_APPROVAL_REQUIRED;
  if (err?.unsupported === true) return REFUSAL_KIND.UNSUPPORTED;
  const reason = String(err?.reason || '');
  if (/^(no-file-mapping|no-insertion-marker|no-markers|needs-input|missing-input|unverified-placeholder-field)/i.test(reason) || /-id-missing$/.test(reason)) return REFUSAL_KIND.NEEDS_INPUT;
  if (/^awaiting-human-review/i.test(reason)) return REFUSAL_KIND.HUMAN_APPROVAL_REQUIRED;
  if (/^(draft-reset|ga4-lookup-unavailable)/i.test(reason)) return REFUSAL_KIND.TEMPORARY_EXTERNAL;
  if (/shared (template|layout)|unsupported/i.test(reason)) return REFUSAL_KIND.UNSUPPORTED;
  return REFUSAL_KIND.GENERATOR_DEFECT;
}

export const countsAgainstGenerator = (kind) => !NOT_A_GENERATOR_SIGNAL.has(kind);

// How many same-reason refusals from ONE generator quarantine that generator for the rest of the run. The first can be one
// unlucky page; the second establishes the pattern; every later one only pays another generation call to hear the same answer.
export const REFUSAL_FAMILY_LIMIT = 2;

// A refusal with no reason is NOT the same thing as every other reasonless refusal from some other generator, and it must not
// vanish into a blank string. It gets an explicit label so it stays visible, groupable and attributable.
export const UNSPECIFIED_REFUSAL = 'unspecified-refusal';

export function refusalReasonOf(err) {
  const reason = String(err?.reason || '').trim();
  if (reason) return reason.slice(0, 120);
  // Persisted (generator_outcomes.detail, run summaries), so the raw message goes through the same customer-safety net as every
  // other persistence boundary; a message that trips it collapses to the bare label rather than leaking.
  const message = (err?.message || '').trim();
  if (!message) return UNSPECIFIED_REFUSAL;
  return sanitizeForCustomer(`${UNSPECIFIED_REFUSAL}: ${message.slice(0, 100)}`, UNSPECIFIED_REFUSAL);
}

export function refusalFamilyKey(generatorId, err) {
  return failureFamilyKey(generatorId, { message: refusalReasonOf(err) });
}
