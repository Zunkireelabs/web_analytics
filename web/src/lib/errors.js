// Client-side mirror of server/lib/errors.js's sanitizeForCustomer. Every
// API error message SHOULD already be safe by the time it reaches the
// browser — the server centralizes that at the source — but this is the
// last stop before ~90 components across this app display `e.message`
// directly (setError(e.message || '...') is the dominant pattern here), and
// it also catches raw browser/network-level failures (e.g. a fetch()
// TypeError) that never passed through the server's sanitizer at all.
// Wired in exactly once, at api.js's req() — every caller benefits without
// needing its own error-handling logic.
const LEAK_PATTERNS = [
  /\bHTTP\s?\d{3}\b/i,
  /\bstatus(?:Code)?[:\s]+\d{3}\b/i,
  /\b(failed|error)\s*\(\d{3}\)/i,
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/, // stack trace frame
  /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN)\b/,
  /\b(openai|anthropic|google (custom )?search|github api|postgres|pg_)\b.{0,40}(failed|error|rejected|denied)/i,
  /request failed\b/i,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError):/,
];

export function safeErrorMessage(text, fallback = 'Something went wrong — please try again.') {
  if (typeof text !== 'string' || !text) return fallback;
  return LEAK_PATTERNS.some((p) => p.test(text)) ? fallback : text;
}
