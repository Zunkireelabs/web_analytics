#!/usr/bin/env node
// CI gate for the exact bug class fixed in the "centralize error sanitization"
// work (see server/lib/errors.js / web/src/lib/errors.js and
// engineering_fix_lessons #41): a caught exception's raw `.message` — or an
// HTTP status/provider error string built from one — landing directly in
// something a customer can see (a thrown Error, a JSON response, a
// recommendation/draft/finding field, a React error banner).
//
// This is a regex net, not a type-checker — it can't see through a helper
// function that does the unsafe interpolation one level removed, and it
// only catches the LITERAL shapes this repo has actually hit twice. That's
// an intentional, cheap tradeoff (see the CI-gate-vs-scheduled-agent
// decision this script came out of): it stops the exact regression from
// recurring at merge time, for near-zero ongoing cost. It does not replace
// judgment — server/lib/errors.js's UserFacingError/safeMessage are still
// the real fix; this only catches someone reaching for the old pattern
// instead.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Anywhere a caught exception's own message is interpolated straight into a
// new string — `${err.message}`, `${e.message}`, string concatenation, or
// String(err.message || err) — is the shape every confirmed leak in this
// repo has taken. A bare `err.message` passed as a single argument (e.g.
// console.error('[x] failed:', err.message), or `err.message` used only in
// a regex .test()/comparison) is NOT flagged — those don't build new
// customer-facing text out of it.
const DANGEROUS_PATTERNS = [
  /\$\{[a-zA-Z_][\w.]*\.message\}/, // `${err.message}` / `${e.message}` interpolation
  /\+\s*[a-zA-Z_][\w.]*\.message\b/, // string concatenation: '...' + err.message
  /String\(\s*[a-zA-Z_][\w.]*\?\.?\.message\s*\|\|/, // String(err?.message || err)
  /`HTTP \$\{[^}]*\.status\}/, // literal `HTTP ${res.status}` template
];

// Files where raw error text is expected and fine: the sanitizer modules
// themselves (they exist to name these exact patterns), tests, CLI-only
// dev/admin tooling (never customer-facing — see server/scripts/README-ish
// convention: everything under server/scripts/ is a manually-invoked
// operator tool), and this file.
const ALLOWED_PATH_PATTERNS = [
  /^server\/lib\/errors\.js$/,
  /^web\/src\/lib\/errors\.js$/,
  /\.test\.js$/,
  /^server\/scripts\//,
  /^server\/scripts\/check-error-leaks\.js$/,
];

// console.error/console.warn calls are logs, not customer content — the
// exact opposite of what this check exists to catch (server/lib/errors.js's
// logInternal explicitly wants raw detail in logs). A line containing
// console.error/console.warn is skipped UNLESS it also builds a separate
// string later reused elsewhere, which this simple per-line check can't see
// — acceptable given the stated regex-net tradeoff above.
//
// Also matches `log.(error|warn|log)(...)` — an injectable-logger seam
// (e.g. `{ log = console } = deps`, recommendation-gates.js) used so tests
// can assert on log output without touching real console. It defaults to
// console at runtime, so it's the same logging call under a different name,
// not a second interpolation site. Confirmed false positive on
// recommendation-gates.js:83/122/185 before this was added.
function isLoggingLine(line) {
  return /console\.(error|warn)\(/.test(line) || /\blog\.(error|warn|log)\(/.test(line) || /\blogInternal\(/.test(line);
}

// `String(err.message || ...).includes('SOME_CODE')` is a content check
// deciding a boolean (e.g. quotaExceeded), not text ever shown to anyone —
// the message's raw wording never leaves this expression. Distinct from
// `error: String(err.message || err)`, which assigns the raw text itself to
// a field that flows onward.
function isMessageContentCheck(line) {
  return /String\([^)]*\.message[^)]*\)\.includes\(/.test(line);
}

// baseRef is the full ref to diff against (e.g. "origin/main"), passed in
// already-resolved by the CI workflow (which fetches it first) — this
// function does no ref-name guessing of its own. A PR is only checked
// against the NEW lines it introduces, never the whole codebase: this is a
// ratchet against pre-existing debt (14 real, pre-existing instances this
// script found in server/ingest/, server/routes/clients.js, etc. — real
// bugs, but retroactively failing every future PR on unrelated code would
// make the gate something people learn to ignore, not fix).
function changedJsFiles(baseRef) {
  try {
    const out = execSync(`git diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`, { encoding: 'utf8' });
    return out.split('\n').filter((f) => /\.(js|jsx)$/.test(f) && !ALLOWED_PATH_PATTERNS.some((p) => p.test(f)));
  } catch {
    return null; // no baseRef (e.g. local run outside a PR) — caller falls back to a full scan
  }
}

// Restricts findings to lines the diff actually added (not just files that
// happen to contain a pre-existing match elsewhere) — the real ratchet
// boundary. Parses `git diff -U0`'s own hunk headers rather than shelling
// out per-line, since that's the one format git guarantees is stable.
function addedLineNumbers(baseRef, file) {
  const out = execSync(`git diff -U0 --diff-filter=ACMR ${baseRef}...HEAD -- ${JSON.stringify(file)}`, { encoding: 'utf8' });
  const added = new Set();
  let current = null;
  for (const line of out.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) { current = Number(hunk[1]); continue; }
    if (current == null) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) { added.add(current); current++; }
    else if (!line.startsWith('-') && !line.startsWith('---')) { current++; }
  }
  return added;
}

function allJsFiles() {
  const out = execSync(
    `git ls-files -- 'server/**/*.js' 'web/src/**/*.js' 'web/src/**/*.jsx'`,
    { encoding: 'utf8' }
  );
  return out.split('\n').filter((f) => f && !ALLOWED_PATH_PATTERNS.some((p) => p.test(f)));
}

function main() {
  // CI_BASE_REF is set by the workflow to an already-fetched ref (e.g.
  // "origin/main") — unset for a local/manual run, which falls back to
  // scanning every tracked file (useful for auditing existing debt, as this
  // script's own development did; not what CI actually runs).
  const baseRef = process.env.CI_BASE_REF || null;
  const files = (baseRef && changedJsFiles(baseRef)) || allJsFiles();

  const findings = [];
  for (const file of files) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const addedLines = baseRef ? addedLineNumbers(baseRef, file) : null;
    content.split('\n').forEach((line, i) => {
      const lineNo = i + 1;
      if (addedLines && !addedLines.has(lineNo)) return;
      if (isLoggingLine(line) || isMessageContentCheck(line)) return;
      if (DANGEROUS_PATTERNS.some((p) => p.test(line))) {
        findings.push({ file, line: lineNo, text: line.trim() });
      }
    });
  }

  if (!findings.length) {
    console.log(`[check-error-leaks] clean — ${files.length} file(s) checked.`);
    return;
  }

  console.error(`[check-error-leaks] found ${findings.length} possible raw-error-leak(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.text}`);
  }
  console.error(
    '\nA caught exception\'s raw .message (or a literal HTTP status) is being built into a new string here — ' +
    'this is the exact leak class fixed in engineering_fix_lessons #41. Route it through ' +
    'server/lib/errors.js\'s safeMessage()/UserFacingError (server) or web/src/lib/errors.js\'s ' +
    'safeErrorMessage() (frontend) instead. If this is a genuine false positive (e.g. logging-only ' +
    'text this check didn\'t recognize as a log line), adjust ALLOWED_PATH_PATTERNS/isLoggingLine in ' +
    'server/scripts/check-error-leaks.js rather than bypassing the check.'
  );
  process.exitCode = 1;
}

main();
