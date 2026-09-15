// Exact-match-or-refuse patch for the "soft 404" nginx misconfiguration:
// a static-site catch-all route (`try_files $uri $uri/ $uri.html /index.html;`)
// with no `=404`/`error_page 404` anywhere in the file falls back to serving
// the HOMEPAGE with a 200 status for every unmatched URL — a typo, an old
// removed page, a malformed generated link — instead of a real 404. Google
// then sees hundreds of distinct URLs all serving identical content and
// buckets most of them as duplicate/alternate-canonical, not "not found".
//
// This is a single-line, mechanical, reversible change (drop the `/index.html`
// fallback in favor of `=404`), same "exact-match-or-refuse, never guess"
// discipline as href-rewrite-inject.js: if the file doesn't contain this
// EXACT line, or already has its own error_page 404 handling, this refuses
// rather than reinterpreting an unfamiliar config.

const FALLBACK_LINE = /^(\s*)try_files\s+\$uri\s+\$uri\/\s+\$uri\.html\s+\/index\.html;\s*$/m;

export function detectSoftNotFoundFallback(content) {
  return FALLBACK_LINE.test(content);
}

export function patchSoftNotFoundFallback(content) {
  if (/error_page\s+404\b/.test(content)) {
    return { ok: false, reason: 'already-resolved', error: 'This config already has an error_page 404 directive — nothing left to patch.' };
  }
  const occurrences = content.match(new RegExp(FALLBACK_LINE.source, 'gm')) || [];
  if (occurrences.length > 1) {
    return { ok: false, reason: 'ambiguous-match', error: 'Found more than one matching fallback line — refusing to guess which is the real catch-all route.' };
  }
  const match = FALLBACK_LINE.exec(content);
  if (!match) {
    return {
      ok: false,
      reason: 'no-match',
      error: 'Could not find the exact `try_files $uri $uri/ $uri.html /index.html;` fallback line in this file — it may have already changed, or use a different structure this fix can\'t safely rewrite.',
    };
  }
  const indent = match[1];
  const before = match[0];
  const after = `${indent}try_files $uri $uri/ $uri.html =404;`;
  const newContent = content.slice(0, match.index) + after + content.slice(match.index + before.length);

  return { ok: true, newContent, before, after };
}
