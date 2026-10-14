// Pure, deterministic generator — no LLM call. There's exactly one correct
// viewport value; the implementer (server/implementers/backend.js) inserts
// or replaces the <meta name="viewport"> tag in the shared layout template
// (server/implementers/lib/viewport-inject.js). Setting the WHOLE content
// value (not patching pieces of it) is what fixes all three real mobile-
// usability findings this can be recommended from — missing, misconfigured
// (no width=device-width), and zoom-blocking (user-scalable=no /
// maximum-scale<=1) — with the same one draft.

export const meta = {
  id: 'viewport',
  name: 'Viewport Meta Generator',
  description: 'Drafts the correct <meta name="viewport"> tag for the shared layout template.',
  recommendationTags: [],
};

import { analyzePageUrl } from '../agents/lib/page-content.js';
import { siteOriginFor } from '../agents/lib/site-domain.js';

const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1';

export async function generate() {
  return {
    content: { viewportContent: VIEWPORT_CONTENT },
    summary: `Set <meta name="viewport" content="${VIEWPORT_CONTENT}"> on the shared layout template.`,
  };
}

// Side-effect-free re-verification (server/generators/lib/verification-layer.js).
// Same shared-template reasoning as html-lang.js's own verifyCurrentState:
// no per-recommendation page, so the site's own public origin is the
// checkable target. mobile-usability.js recommends this generator for THREE
// distinct problems that all resolve to the exact same drafted content
// (missing, missing device-width, zoom-blocking) — already_resolved
// therefore requires all three to now be fixed, not just whichever one
// originally triggered the finding, since a still-present second problem
// means this recommendation's premise (the live viewport tag is wrong) is
// still true.
export async function verifyCurrentState(rec, { site } = {}) {
  if (!site) return { decision: 'still_valid', reason: 'no-site-context', evidence: null };
  const target = rec.params?.page || rec.page || siteOriginFor(site);
  if (!target) return { decision: 'still_valid', reason: 'no-checkable-target', evidence: null };

  const fetched = await analyzePageUrl(target);
  if (!fetched.ok) return { decision: 'still_valid', reason: 'unreachable', evidence: { target, error: fetched.error } };

  const { hasViewportMeta, viewportHasDeviceWidth, viewportBlocksZoom } = fetched.analysis;
  if (hasViewportMeta && viewportHasDeviceWidth && !viewportBlocksZoom) {
    return { decision: 'already_resolved', reason: 'viewport-already-correct', evidence: { target } };
  }
  return {
    decision: 'still_valid', reason: 'viewport-still-needs-fix',
    evidence: { target, hasViewportMeta, viewportHasDeviceWidth, viewportBlocksZoom },
  };
}
