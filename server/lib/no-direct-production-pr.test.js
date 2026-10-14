import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// STRUCTURAL REGRESSION GUARD for "no autonomous production generator may
// open its own PR; only the shared shipping queue's 07:00 batch may."
//
// Three real bypasses were found and closed this way: learned-repair.js,
// repair-site-content-live.js (content-repair), and
// repair-template-capability.js. Each now enqueues via
// store/shipping-queue.js instead of calling github/client.js's
// createBranch/openPullRequest directly. This test exists so a FOURTH one
// can't be silently reintroduced later — anything under server/agents/lib/
// or server/scripts/ that calls openPullRequest directly must be on the
// explicit ALLOWLIST below, with a reason, not merely absent from this list
// by omission.
//
// ALLOWLIST — every real, reviewed exception:
//   - code-self-repair.js: repairs THIS PLATFORM'S OWN repository, never a
//     tenant's. The one explicit exception named throughout this feature
//     (lib/autonomous-quota.js's own header comment).
//   - install-rendering-workflow.js, repair-missing-tailwind-typography.js,
//     bootstrap-structural-markers.js: MANUAL, human-invoked CLI onboarding
//     tools (run via `npm run <script> --site-id N` by a person) — never
//     called from job.js/cron.js, so never part of the autonomous daily
//     pipeline this rule governs. Confirmed by this test's own second check
//     below: their non-presence in job.js's *ForAllSites exports.
const ALLOWLIST = new Set([
  'code-self-repair.js',
  'install-rendering-workflow.js',
  'repair-missing-tailwind-typography.js',
  'bootstrap-structural-markers.js',
]);

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..'); // server/lib -> server

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

// Strips only comments (not string literals — an import specifier like
// '../../store/shipping-queue.js' has to survive) so a doc-comment naming
// "openPullRequest" (like this very file's own header, or
// repair-template-capability.js's post-fix explanation of what it used to
// do) can't be mistaken for a real call.
function stripComments(src) {
  return src
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

describe('no autonomous production generator opens a PR directly', () => {
  test('every file under server/agents/lib and server/scripts calling openPullRequest is on the explicit allowlist', () => {
    const dirs = [join(serverRoot, 'agents', 'lib'), join(serverRoot, 'scripts')];
    const offenders = [];
    for (const dir of dirs) {
      for (const file of jsFilesUnder(dir)) {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (/\bopenPullRequest\s*\(/.test(code)) {
          const base = file.split('/').pop();
          if (!ALLOWLIST.has(base)) offenders.push(file.replace(serverRoot, 'server'));
        }
      }
    }
    assert.deepEqual(offenders, [], 'a new file calls openPullRequest directly — route it through store/shipping-queue.js instead, or add it to ALLOWLIST here with a reviewed reason');
  });

  test('the three closed bypasses no longer call openPullRequest at all', () => {
    for (const file of ['agents/lib/learned-repair.js', 'scripts/repair-site-content-live.js', 'scripts/repair-template-capability.js']) {
      const code = stripComments(readFileSync(join(serverRoot, file), 'utf8'));
      assert.doesNotMatch(code, /\bopenPullRequest\s*\(/, `${file} must never call openPullRequest directly again`);
    }
  });

  test('the three closed bypasses DO call the shared shipping queue', () => {
    for (const file of ['agents/lib/learned-repair.js', 'scripts/repair-site-content-live.js', 'scripts/repair-template-capability.js']) {
      const code = stripComments(readFileSync(join(serverRoot, file), 'utf8'));
      assert.match(code, /shipping-queue\.js/, `${file} must route production work through store/shipping-queue.js`);
    }
  });

  test('the manual-CLI allowlist entries are confirmed absent from job.js\'s autonomous *ForAllSites exports', () => {
    const jobSrc = stripComments(readFileSync(join(serverRoot, 'job.js'), 'utf8'));
    for (const manual of ['install-rendering-workflow', 'repair-missing-tailwind-typography', 'bootstrap-structural-markers']) {
      assert.doesNotMatch(jobSrc, new RegExp(manual), `${manual}.js must stay a manual CLI tool, never wired into the autonomous daily job.js pipeline`);
    }
  });
});
