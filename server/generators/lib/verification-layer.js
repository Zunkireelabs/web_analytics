// Shared pre-flight verification contract — the DISCOVER -> VERIFY_CURRENT_STATE
// stage every generator can plug into before the shared pipeline decides
// whether to (re)generate a draft, spend a retry/recovery cycle, or give up.
//
// This does NOT replace the decision layers that already exist:
//   - recommendation-gates.js   — pre-creation gates (drop / blockedReason)
//   - attempt-classification.js — post-failure retry policy
//   - autonomy-decision.js      — risk/status -> who is allowed to act
//   - fix-verification.js       — post-ship live re-check
// It fills the gap those four don't cover: a safe, side-effect-free re-check
// of whether a recommendation's own premise still holds, run BEFORE a fix is
// (re)attempted. A generator with no verifier keeps exactly today's
// behavior — `still_valid`, no evidence — since assuming otherwise without a
// real check would itself be the kind of guess this framework exists to
// avoid.
//
// Contract (documentation-only, mirrors generators/types.js's discipline):
//   export async function verifyCurrentState(rec, ctx) -> Promise<{
//     decision: one of VERIFICATION_DECISION,
//     reason:   short machine-readable code, generator-specific,
//     evidence: whatever real evidence was inspected (repo content, live
//               HTML, search results, ...) — never fabricated, never guessed.
//   }>
// `rec` is a recommendations-table row (or any object with the same
// .recommendation_type / .params shape); `ctx` carries whatever the caller
// already has on hand (typically { site }) so the generator never has to
// re-fetch what its caller already loaded.

import { getGenerator } from '../registry.js';
import { resolveOwnership } from '../../implementers/lib/url-file-map.js';
import { resolvePageMove } from '../../lib/redirect-resolution.js';
import { PAGE_CONTENT_GENERATORS, chooseEditMethod } from '../../implementers/lib/page-source.js';

// Generators whose work is bound to ONE live page address in rec.params.page. If that address now permanently redirects to a different
// page, the recommendation describes a page that no longer lives there. Generators that act on the redirect itself (redirect-*,
// broken-link-fix, sitemap-*), on the site as a whole (robots, llms, analytics, security-headers) or on a not-yet-existing page are
// deliberately NOT here.
export const PAGE_BOUND_GENERATORS = new Set([
  'internal-links', 'breadcrumbs', 'faq', 'schema', 'schema-repair', 'meta-title', 'open-graph', 'alt-text', 'direct-answer',
  'expand-content', 'refresh-content', 'canonical', 'html-lang', 'viewport', 'qa-content',
]);

export const VERIFICATION_DECISION = Object.freeze({
  ALREADY_RESOLVED: 'already_resolved',
  STILL_VALID: 'still_valid',
  NEEDS_UPDATE: 'needs_update',
  OBSOLETE: 'obsolete',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  UNSAFE: 'unsafe',
  NEEDS_HUMAN: 'needs_human',
});

const VALID_DECISIONS = new Set(Object.values(VERIFICATION_DECISION));

// Re-inspects reality for one recommendation and returns a normalized
// decision. Never throws — a verification failure (network blip, transient
// GitHub error) is not evidence about the recommendation itself, so it falls
// back to `still_valid` with the error attached as evidence, the same
// fail-safe behavior action-center-reconciler.js's own re-check try/catches
// already apply by hand for broken-link-fix.
export async function verifyRecommendation(rec, ctx = {}) {
  const pageUrl = rec.params?.page || rec.page || null;

  // 1. WHO SERVES THIS PAGE? A URL declared as another app's (url_file_map.otherApps) can never be fixed in the connected repo. Park it
  //    once with the reason instead of drafting a change that fails at apply time, every day. Pure: no network.
  if (ctx.site && pageUrl && /^https?:\/\//i.test(pageUrl)) {
    const own = resolveOwnership(ctx.site, pageUrl);
    if (own.owner === 'other') {
      return { decision: VERIFICATION_DECISION.NEEDS_HUMAN, reason: 'page-served-by-another-app', evidence: { page: pageUrl, app: own.app, repo: own.repo, message: own.message } };
    }
  }

  // 1b. WHERE DOES THIS PAGE'S CONTENT LIVE? When the caller supplies a verifier (built from the real repository tree, see
  //     implementers/lib/page-source.js), a page-specific change is only drafted if the page has a verified file or data store of its own.
  //     A shared template, a data-driven page with no matching store, or an unverifiable page stops here with a reason: never a write to a guess.
  //     Breadcrumbs keep their own template-level path. A verifier that errors says nothing about the page and never blocks.
  if (ctx.resolveSource && pageUrl && PAGE_CONTENT_GENERATORS.has(rec.recommendation_type) && /^https?:\/\//i.test(pageUrl)) {
    const source = await ctx.resolveSource(pageUrl).catch(() => null);
    if (source) {
      const method = chooseEditMethod(source, rec.recommendation_type);
      if (method.method === 'investigate') {
        return { decision: VERIFICATION_DECISION.NEEDS_HUMAN, reason: method.reason, evidence: { page: pageUrl, sourceKind: source.kind, message: method.message } };
      }
    }
  }

  // 2. HAS THE PAGE MOVED? Follow the address (same site, read-only). A permanent move means the recommendation is about a page that is
  //    no longer there: it is OBSOLETE (not "resolved": the problem may still exist at the new address, where the next audit re-detects
  //    it). A chain that cannot be read says nothing and falls through to the normal check.
  if (pageUrl && PAGE_BOUND_GENERATORS.has(rec.recommendation_type) && /^https?:\/\//i.test(pageUrl)) {
    const move = await (ctx.resolvePageMove || resolvePageMove)(pageUrl).catch(() => null);
    if (move?.ok && move.moved) {
      return {
        decision: VERIFICATION_DECISION.OBSOLETE, reason: 'page-moved',
        evidence: { page: pageUrl, finalUrl: move.finalUrl, status: move.hops?.[0]?.status ?? move.status, permanent: !!move.permanent, hops: move.hops?.length ?? 0,
          message: `This page no longer lives at ${pageUrl}: it redirects to ${move.finalUrl}. The next audit re-checks the page at its current address.` },
      };
    }
  }

  const generator = await getGenerator(rec.recommendation_type);
  if (!generator || typeof generator.verifyCurrentState !== 'function') {
    return { decision: VERIFICATION_DECISION.STILL_VALID, reason: 'no-verifier-available', evidence: null };
  }
  try {
    const result = await generator.verifyCurrentState(rec, ctx);
    if (!result || !VALID_DECISIONS.has(result.decision)) {
      throw new Error(`verifyCurrentState for "${rec.recommendation_type}" returned an invalid decision: ${result?.decision}`);
    }
    return result;
  } catch (err) {
    return { decision: VERIFICATION_DECISION.STILL_VALID, reason: 'verification-error', evidence: { error: err.message } };
  }
}

// True only for the one decision every caller can safely act on without any
// generator-specific branching: nothing to fix, close it, don't spend a
// retry/recovery cycle. Every other decision needs the caller to know its
// own domain (e.g. how "needs_human" should be surfaced) rather than being
// generalized here.
export function isAlreadyResolved(verification) {
  return verification?.decision === VERIFICATION_DECISION.ALREADY_RESOLVED;
}
