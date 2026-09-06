// Generic pre-PR Rendering Validation Gate — runs once, in the single choke
// point every implementer's apply() already shares (github-ops.js's
// pushDraftBranch), so any current or future generator/implementer that
// writes a brand-new rendered page inherits this automatically, with zero
// per-generator code. This is deliberately NOT specific to legal/compliance
// pages — it fires for any file tagged `contentFormat: 'markdown'`
// (landing pages, blog posts, direct-answer pages, translations, legal
// pages, and whatever's built next that reuses newpage-render.js's shape).
//
// The problem this prevents: a generator can produce a perfectly correct
// Markdown body, but if the site's own static-site generator doesn't run a
// Markdown pass on the file extension/engine the draft is about to be
// committed to (e.g. a bare `.njk`/`.html` target with no markdown filter),
// the raw `# ## ** -` syntax ships to the browser exactly as written. That
// failure is invisible from the Markdown source alone — it's a property of
// the TARGET repo's build, which this app never runs (see
// action-center-onboarding skill) — so it can only be guarded against with
// explicit, human-recorded capability metadata, never guessed from the
// extension string alone. Fails closed: no recorded capability for a
// target is treated the same as an unsafe one. A real PR is never opened
// for a file this gate can't positively vouch for.
//
// Capability metadata lives at `site.url_file_map.renderCapabilities`,
// recorded once per site via `npm run connect-repo` (same file/step that
// already records pages/patterns/newContentTargets/siteRoot — see
// implementers/types.js) — NOT inferred here from file extension alone, so
// it stays correct across static-site generators/frameworks this module has
// no built-in knowledge of (Eleventy, Hugo, Astro, Jekyll, whatever a future
// client uses). Shape:
//
//   renderCapabilities: {
//     generator: 'eleventy',                 // free-text, informational only
//     extensions: {
//       '.md':     { markdown: true },
//       '.11ty.md':{ markdown: true },
//       '.njk':    { markdown: false },       // Nunjucks alone does not run a markdown pass
//       '.html':   { markdown: false },
//     },
//     // Per-action-type override — for a target whose extension alone is
//     // ambiguous (e.g. a `.njk` target whose file is known to carry a real
//     // `templateEngineOverride`/markdown filter proving THIS specific
//     // target renders markdown even though the extension in general
//     // doesn't). Checked before the extension table.
//     overrides: {
//       'landing-page': { markdown: true },
//     },
//   }

import { getCheckRunsForRef } from '../../github/client.js';
import { safeMessage } from '../../lib/errors.js';

// Longest known compound suffix first (e.g. `.11ty.md` before `.md`) so a
// generator-specific compound extension isn't shadowed by naively splitting
// on the last dot only.
export function extensionOf(filePath) {
  const base = String(filePath || '').split('/').pop() || '';
  const m = base.match(/(\.[a-z0-9]+\.[a-z0-9]+|\.[a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

// Exported so audit-url-file-map.js's onboarding-completeness check can
// resolve the exact same capability the real gate will check at apply time
// (one evidence path, not a second guess at it) — reports a gap at
// onboarding-audit time instead of only discovering it the first time a
// real draft tries to apply.
export function resolveCapability(site, file) {
  const caps = site?.url_file_map?.renderCapabilities;
  if (!caps) return { caps: null, capability: null };
  const override = file.actionType ? caps.overrides?.[file.actionType] : null;
  if (override) return { caps, capability: override };
  return { caps, capability: caps.extensions?.[extensionOf(file.path)] || null };
}

// Phase 1 check: does recorded site config prove this specific target gets
// Markdown-processed? `file.contentFormat` is set only by the code paths
// that actually construct a fresh Markdown body (see newpage-render.js /
// frontend.js) — a marker-splice or data-adapter write never sets it, so
// this check is a no-op for every other kind of write, unchanged from
// today's behavior.
function checkRenderCapability(site, file) {
  if (file.contentFormat !== 'markdown') return { ok: true };

  const { caps, capability } = resolveCapability(site, file);
  if (!caps) {
    return {
      ok: false,
      reason: 'render-capabilities-not-configured',
      error: `${site?.name || `site #${site?.id}`} has no url_file_map.renderCapabilities recorded — run \`npm run connect-repo\` to record how this site's static-site generator renders each file extension before new pages can be applied.`,
    };
  }
  if (!capability) {
    return {
      ok: false,
      reason: 'render-capability-unknown',
      error: `No recorded rendering capability for "${file.path}" (extension "${extensionOf(file.path)}") — add an entry to url_file_map.renderCapabilities.extensions, or an override for "${file.actionType}", via \`npm run connect-repo\` before this can be applied.`,
    };
  }
  if (!capability.markdown) {
    return {
      ok: false,
      reason: 'render-unsafe-target',
      error: `"${file.path}" is recorded as NOT Markdown-safe (extension "${extensionOf(file.path)}") — committing this file would ship raw Markdown syntax (# ## ** -) visible in the browser instead of rendered HTML. Point this target at a Markdown-processed extension (e.g. .md/.11ty.md) or record a renderCapabilities override proving this target runs a Markdown pass, via \`npm run connect-repo\`.`,
    };
  }
  return { ok: true };
}

// Ordered checks run synchronously, before a single byte is committed —
// everything here must be answerable from config alone, with no real build
// or PR required. Phase 2 (checkClientBuildStatus, below) deliberately does
// NOT live in this array: it needs a real build of a real committed ref,
// which can only exist once a branch/PR is already out there, so "block the
// commit" isn't available to it the way it is here. It shares this same
// {ok, reason, error} contract instead, so any caller (a future merge-gate,
// an Action Center UI badge) can treat both phases uniformly.
const CHECKS = [checkRenderCapability];

export async function validateRendering(site, file) {
  for (const check of CHECKS) {
    // eslint-disable-next-line no-await-in-loop -- checks must run in order and short-circuit on first failure
    const result = await check(site, file);
    if (!result.ok) return result;
  }
  return { ok: true };
}

// Used by pushDraftBranch — every file about to be committed is checked
// before ANY of them are written, so a batch never partially lands.
export async function validateRenderingBatch(site, files) {
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- must fail on the first unsafe file, in file order
    const result = await validateRendering(site, file);
    if (!result.ok) return result;
  }
  return { ok: true };
}

// Phase 2: the client repo's own real build, run in GitHub Actions (never
// on this app's infrastructure — see the "Build location" decision recorded
// in action-center-onboarding SKILL.md §1b), reporting back as a named
// GitHub Check Run this app reads rather than re-deriving. Installed once
// per site via server/scripts/install-rendering-workflow.js, which writes
// the workflow under this exact job name so this lookup always matches it.
//
// Not called from pushDraftBranch (see CHECKS comment above) — a caller
// checks this AFTER a PR already exists, e.g. before letting staff mark a
// draft "approved/published" in this app's own tracking, or before
// surfacing a merge-readiness badge in the Action Center UI. `ref` is
// whatever real commit/branch/PR-head GitHub can resolve a check run
// against — typically `draft.branch_name`.
export const CLIENT_BUILD_CHECK_NAME = 'rendering-validation';

// `getCheckRuns` defaults to the real GitHub read (github/client.js) — same
// dependency-injection shape as adapters/data-array-content.js's
// isDataReady(fetchFile), so tests can inject a fake without hitting the
// network.
export async function checkClientBuildStatus(site, ref, getCheckRuns = getCheckRunsForRef) {
  let runs;
  try {
    runs = await getCheckRuns(site, ref);
  } catch (err) {
    const { message } = safeMessage('rendering-gate.checkClientBuildStatus', err, `Could not read GitHub check runs for "${ref}" right now.`);
    return {
      ok: false, reason: 'client-build-check-unavailable',
      error: message,
    };
  }

  const run = runs.find((r) => r.name === CLIENT_BUILD_CHECK_NAME);
  if (!run) {
    return {
      ok: false, reason: 'client-build-check-not-configured',
      error: `No "${CLIENT_BUILD_CHECK_NAME}" check found on "${ref}" — this repo hasn't had the rendering-validation workflow installed yet (run \`node server/scripts/install-rendering-workflow.js --site-id ${site?.id}\`), or the check hasn't started yet.`,
    };
  }
  if (run.status !== 'completed') {
    return {
      ok: false, reason: 'client-build-check-pending',
      error: `"${CLIENT_BUILD_CHECK_NAME}" check on "${ref}" is still ${run.status} — wait for it to finish before treating this draft as safe to merge.`,
    };
  }
  if (run.conclusion !== 'success') {
    return {
      ok: false, reason: 'client-build-check-failed',
      // Two independent things can fail inside this one check run (they run
      // as steps in the same job — see rendering-validation-templates/
      // workflow.yml): the built HTML still has raw Markdown/unresolved
      // template syntax, OR a change leaked into sibling pages of a shared,
      // data-driven template family (check-family-siblings.mjs). Either way
      // the check run's own conclusion already fails closed here — this is
      // just an honest error message pointing at both possible causes rather
      // than naming only the first one that used to exist.
      error: `"${CLIENT_BUILD_CHECK_NAME}" check on "${ref}" concluded "${run.conclusion}" — either the real built page contains raw Markdown/unresolved template syntax, or a change leaked into sibling pages of a shared template family. Open the PR's Checks tab for details before merging.`,
    };
  }
  return { ok: true };
}
