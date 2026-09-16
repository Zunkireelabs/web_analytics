// Centralized error-sanitization boundary. Every customer-facing surface
// (recommendations, drafts, findings, reports, chat, the API's own error
// responses) must route failure text through this module rather than
// building its own string from a caught exception — see the confirmed leak
// chains this closed: GitHub's raw response body reaching drafts.apply_error
// and the Draft modal, Google Custom Search's raw error reaching the
// generator API response, raw fetch() exceptions reaching finding text, and
// raw sub-agent failures being fed into LLM prompts that then paraphrase
// them into chat/report output.
//
// The design is default-safe, not a denylist: nothing reaches a customer
// unless a developer explicitly wrapped it in UserFacingError. A regex net
// (sanitizeForCustomer) exists too, but only as defense-in-depth for text
// that reaches persistence through a path nobody marked either way — it is
// not the primary mechanism, because a denylist can never enumerate every
// future provider's error format.

import { randomUUID } from 'node:crypto';
import { query } from '../db.js';

// The one legitimate way code may put a specific message in front of a
// customer — e.g. "this page isn't mapped in url_file_map yet, run
// connect-repo first". Deliberate, developer-authored, contains no
// interpolated exception text. Anything NOT thrown/returned as one of these
// is assumed unsafe and gets replaced with generic text before it's shown.
export class UserFacingError extends Error {
  constructor(message, { status = 400, code = null, cause = null } = {}) {
    super(message);
    this.name = 'UserFacingError';
    this.userFacing = true;
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// The one place a raw exception's full detail is allowed to be written down
// — logs are for developers, never for customers. Returns a short
// correlation id a customer-facing generic message can reference, so a
// developer can find the real error later without the customer ever seeing
// it. `context` is a short string identifying the call site (e.g.
// 'github-ops.pushDraftBranch'), not customer-facing.
export function logInternal(context, err) {
  const id = randomUUID().slice(0, 8);
  console.error(`[internal-error:${id}] ${context}:`, err?.stack || err?.message || err);
  // err.cause is where the ACTUAL diagnostic detail often lives — e.g.
  // openhands-handler.js wraps every Design Agent failure in a
  // UserFacingError with a safe, generic customer message, and attaches the
  // real Python/Docker exception as `cause` specifically so a developer could
  // recover it here. Error#stack never includes `cause` on Node 20 (no
  // "Caused by:" appended the way newer runtimes/browsers do it), so without
  // this the cause was captured correctly and then silently dropped at the
  // one place this module's own doc comment promises "the full detail is
  // allowed to be written down" — confirmed live: `docker logs
  // design-agent-worker-stage` showed nothing but the generic wrapper
  // message on every failed run, even with direct server access, because
  // this line never printed the one thing (Docker daemon vs LLM auth) that
  // would have told an engineer what to actually fix.
  const causeStack = err?.cause ? (err.cause?.stack || err.cause?.message || String(err.cause)) : null;
  if (causeStack) console.error(`[internal-error:${id}] caused by:`, causeStack);

  // Console output alone is only as durable as the container's log
  // retention — a customer-facing "ref: <id>" promises a developer can look
  // it up later, and once logs rotate that promise is broken (confirmed:
  // Chayce Properties draft #1741's "ref: b6cfde8a" was unresolvable 13 days
  // later, log evidence long gone). Best-effort and fire-and-forget: a
  // failure to persist this record must never mask, delay, or throw over
  // the original error logInternal exists to report.
  // Wrapped in Promise.resolve() because a handful of test suites mock this
  // module's `query` with a synchronous fake (returns a plain object, not a
  // Promise) — real db.js's query is always a Promise, but this call must
  // not assume that to stay fire-and-forget-safe either way.
  Promise.resolve(query(
    `INSERT INTO internal_errors (id, context, message, stack, cause_message, cause_stack)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [id, context, err?.message || String(err), err?.stack || null, err?.cause?.message || null, causeStack]
  )).catch((persistErr) => {
    console.error(`[internal-error:${id}] could not persist this error record:`, persistErr.message);
  });

  return id;
}

// The standard shape for "this specific thing failed, but stay contextual
// (per this repo's own past-lesson: generic-for-genericness'-sake is worse
// UX than naming *what* didn't work) without ever quoting the failure
// itself". `fallback` should name the category of thing that failed in
// plain terms a customer already understands ("this page couldn't be
// checked right now", "citation search is temporarily unavailable") — never
// provider names, statuses, or exception text. Logs the real error
// internally and returns { message, id } for the caller to use in
// customer-facing text/UI and internal diagnostics respectively.
export function safeMessage(context, err, fallback) {
  const id = logInternal(context, err);
  return { message: fallback, id };
}

// Defense-in-depth net for the persistence boundary (drafts, agent runs,
// audit runs) — catches anything that reaches here despite not going
// through safeMessage/UserFacingError deliberately. Matches HTTP
// status-code patterns, stack-trace markers, common provider-error
// templates, and raw Node/network exception names. Redacts the WHOLE
// string (not just the matched substring) rather than trying to surgically
// remove just the dangerous part — a partially-redacted error is still an
// error message with the customer-facing framing that made it dangerous in
// the first place; better to fall back to a plain safe placeholder and log
// what was blocked so a developer can fix the actual source.
const LEAK_PATTERNS = [
  /\bHTTP\s?\d{3}\b/i,
  /\bstatus(?:Code)?[:\s]+\d{3}\b/i,
  /\b(failed|error)\s*\(\d{3}\)/i,
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/, // stack trace frame
  /node_modules[\\/]/,
  /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN)\b/,
  /\b(openai|anthropic|google (custom )?search|github api|postgres|pg_)\b.{0,40}(failed|error|rejected|denied)/i,
  /request failed\b/i,
  // `TypeError: message` only ever appears in err.stack/err.toString() — a
  // real Error's own `.message` NEVER carries the class-name prefix, so this
  // pattern alone never matches the single most common shape of an uncaught
  // internal crash reaching this boundary: the bare V8/Node built-in message
  // (confirmed live, 2026-09-09: "Cannot read properties of null (reading
  // 'id')" reached an Action Center card verbatim, unredacted, because it
  // is exactly this shape). The patterns below match those bare messages
  // directly, with no class-name prefix to depend on.
  /\b(TypeError|ReferenceError|SyntaxError|RangeError):/,
  // Matches both Node's current wording ("...properties of null (reading
  // 'x')") and the older pre-2020 V8 form ("...property 'x' of undefined") —
  // the property name and quoting differ between them, so this only pins the
  // stable prefix rather than the whole phrase.
  /\bCannot read propert(?:y|ies)\b/i,
  /\bis not a function\b/i,
  /\bis not defined\b/i,
  /\bis not iterable\b/i,
  /\bis not a valid\b/i,
  /\bundefined is not an object\b/i,
  /\bMaximum call stack size exceeded\b/i,
  /\bAssignment to constant variable\b/i,
  /\bCannot convert (?:undefined|null|object) to\b/i,
  /\bInvalid array length\b/i,
  /\bout of memory\b/i,
];

export function sanitizeForCustomer(text, fallback = null) {
  if (typeof text !== 'string' || !text) return text;
  return LEAK_PATTERNS.some((p) => p.test(text)) ? fallback : text;
}

// Walks every string value in a plain object/array tree and applies
// sanitizeForCustomer, for the rare case where a whole structured payload
// (not just one error field) needs to pass through the net before
// persistence. Non-string values are left untouched.
// Two small, safe categorizers for the single most common leak shape in
// this codebase: a page-fetch or link-check helper storing its failure
// reason in an `error` field that later gets string-interpolated straight
// into finding/generator text (e.g. "Could not fetch page: ${fetched.error}").
// Collapsing to one of a few known-safe categories — rather than the raw
// exception or a literal status code — keeps that text genuinely
// informative (this repo's own past lesson: don't go fully generic when
// context is available) without ever repeating a provider's own wording.
// Callers that want the real detail for debugging should also call
// logInternal separately with the same context string.
export function describeFetchFailure(context, err) {
  logInternal(context, err);
  return err?.name === 'AbortError' ? 'timeout' : 'network error';
}

export function describeHttpFailure(status) {
  if (status === 404) return 'not found';
  if (status === 401 || status === 403) return 'access denied';
  if (status >= 500) return 'server error';
  return 'request failed';
}

export function sanitizeDeep(value, fallback = null) {
  if (typeof value === 'string') return sanitizeForCustomer(value, fallback);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, fallback));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v, fallback)]));
  }
  return value;
}
