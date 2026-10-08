// "Does this site's captured design cover what THIS artifact will render?"
//
// A third, stricter tier above the two that exist. isProfileUsable /
// validateDesignProfile are documented structural MINIMUMS for the projectors
// to run at all, and other code depends on exactly that meaning — so they are
// left alone. This answers a different question: not "can a projector run" but
// "will the output match the site", keyed by what the draft actually renders,
// so a tenant is never blocked on fields its draft will not touch.
//
// The owner's rule shapes the result: the agent must never call a design
// "unknown" or "thin" when the site clearly has one. So a gap is first
// DERIVED from the site's own language (using only the fallbacks the real
// projectors already apply — never another tenant's), and only what derivation
// cannot supply is a BLOCK. Pure and synchronous; freshness is passed in.

export const COMPLETENESS_TIERS = Object.freeze(['complete', 'partial', 'thin']);

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const has = (obj, path) => {
  const v = get(obj, path);
  return typeof v === 'string' ? v.trim().length > 0 : v != null && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v);
};

// Each requirement: a field the artifact needs, and (optionally) how the real
// projectors already derive it when absent. `derive` returns the field it
// falls back on, or null when there is no honest derivation.
const REQUIREMENTS = {
  'inline-article': [
    { field: 'typography.body' },
    { field: 'typography.heading.item' },
    { field: 'typography.heading.section', derive: (p) => (has(p, 'typography.heading.item') ? 'typography.heading.item' : null) },
    // A prose width: layout.prose, or the container the projectors wrap in.
    { field: 'layout.prose', derive: (p) => (has(p, 'layout.container') ? 'layout.container' : null) },
  ],
  'section-page': [
    { field: 'typography.body' },
    { field: 'typography.heading.item' },
    { field: 'typography.heading.section', derive: (p) => (has(p, 'typography.heading.item') ? 'typography.heading.item' : null) },
    { field: 'layout.container' },
    { field: 'spacing.section' },
  ],
  faq: [
    { field: 'typography.body' },
    { field: 'typography.heading.item' },
    // projectFaq falls back from an accordion to a styled definition list
    // using only typography, so a missing accordion is derived, not blocking.
    { field: 'components.accordion', derive: (p) => (has(p, 'typography.heading.item') && has(p, 'typography.body') ? 'typography (definition-list fallback)' : null) },
  ],
  'expand-content': [
    { field: 'typography.body' },
    { field: 'typography.heading.item' },
    // No honest derivation of a card: inventing one would be exactly the
    // "agent develops a design the site does not have" the owner rules out.
    { field: 'components.card' },
  ],
  table: [
    { field: 'typography.body' },
    // projectTable derives header/row styling from typography + border/surface.
    { field: 'components.table', derive: (p) => (has(p, 'typography.body') ? 'typography + color.border/surface' : null) },
  ],
  'cta-button': [{ field: 'components.button' }],
};

// Which artifact requirement sets an action touches. Anything not listed
// renders no styled body copy and needs none.
const ARTIFACTS_BY_ACTION = {
  'blog-outline': ['inline-article'],
  'direct-answer': ['inline-article'],
  translation: ['inline-article'],
  'landing-page': ['section-page', 'cta-button'],
  'missing-page': ['section-page'],
  faq: ['faq'],
  'qa-content': ['faq'],
  'expand-content': ['expand-content'],
};

export function artifactsFor(actionType, pageRole = null) {
  const base = ARTIFACTS_BY_ACTION[actionType];
  if (!base) return [];
  // The resolved role beats the action's default: a missing-page that
  // resolved to an article body needs the article fields.
  if (actionType === 'missing-page' && pageRole === 'inline-article') return ['inline-article'];
  return base;
}

/**
 * assessDesignCompleteness(profile, { actionType, pageRole, inlineProse, roleCheck, stale, requireInlineProseMode })
 *
 * Returns { ok, tier, missing, derived, blocks, repairable, artifacts }.
 *   missing  — every required field absent from the profile
 *   derived  — the subset the site's own language fills in
 *   blocks   — what derivation cannot supply (empty means safe to proceed)
 *   repairable — blocks that re-deriving the profile could plausibly fix; a
 *                contradicted/stale profile is repairable, a card the site
 *                has never shown is not (until a page that shows one exists)
 */
export function assessDesignCompleteness(profile, {
  actionType = null, pageRole = null, inlineProse = null,
  roleCheck = null, stale = false, requireInlineProseMode = false,
} = {}) {
  const artifacts = artifactsFor(actionType, pageRole);
  if (!artifacts.length) return { ok: true, tier: 'complete', missing: [], derived: [], blocks: [], repairable: false, artifacts };

  if (!profile || typeof profile !== 'object') {
    return {
      ok: false, tier: 'thin', artifacts, missing: [], derived: [], repairable: true,
      blocks: [{ field: 'designProfile', reason: 'no-design-profile' }],
    };
  }

  const missing = [];
  const derived = [];
  const blocks = [];
  const seen = new Set();

  for (const artifact of artifacts) {
    for (const req of REQUIREMENTS[artifact] || []) {
      if (seen.has(req.field)) continue;
      seen.add(req.field);
      if (has(profile, req.field)) continue;
      missing.push({ field: req.field, artifact });
      const from = req.derive ? req.derive(profile) : null;
      if (from) derived.push({ field: req.field, artifact, from });
      else blocks.push({ field: req.field, artifact, reason: 'not-captured-and-not-derivable' });
    }
  }

  // A profile whose classes no longer exist in the live CSS is worse than none
  // — it ships confidently wrong markup — so contradiction counts as missing.
  if (roleCheck && roleCheck.ok === false) {
    blocks.push({ field: roleCheck.field || 'typography', reason: 'role-contradicted', detail: roleCheck.error || roleCheck.reason || null });
  }
  if (stale) blocks.push({ field: 'designProfile', reason: 'stale-profile' });

  // The inline-prose mode matters only for article bodies, and only blocks
  // once a detector exists to resolve it (see requireInlineProseMode): until
  // then an unset value is the long-standing 'project' default, and blocking
  // every blog on it would take working sites to zero.
  if (artifacts.includes('inline-article') && requireInlineProseMode && !['layout', 'project'].includes(inlineProse)) {
    blocks.push({ field: 'siteRoot.inlineProse', reason: 'inline-prose-mode-unresolved' });
  }

  const tier = blocks.length ? 'thin' : (derived.length ? 'partial' : 'complete');
  const repairable = blocks.some((b) => ['no-design-profile', 'role-contradicted', 'stale-profile', 'inline-prose-mode-unresolved'].includes(b.reason));
  return { ok: blocks.length === 0, tier, missing, derived, blocks, repairable, artifacts };
}

// 'off' | 'log' | 'enforce'. Fail-closed gates hold a draft when they cannot
// confirm it matches the site, which on a fleet with thin design data holds
// nearly everything at once. 'log' runs the same gates and records what WOULD
// have been held (design_gate_decisions) while shipping anyway — the way to
// find out before flipping to 'enforce'. DESIGN_GATE_FAIL_CLOSED=true is the
// original switch and means 'enforce'.
export function designGateMode(env = process.env) {
  if (env.DESIGN_GATE_FAIL_CLOSED === 'true') return 'enforce';
  const m = String(env.DESIGN_GATE_MODE || '').toLowerCase();
  return m === 'enforce' || m === 'log' ? m : 'off';
}

export function isDesignGateFailClosed(env = process.env) {
  return designGateMode(env) === 'enforce';
}

// Human-readable, for blocked_reason and the one-per-episode notification.
export function describeBlocks(assessment) {
  return (assessment?.blocks || []).map((b) => `${b.field}: ${b.reason}${b.detail ? ` (${b.detail})` : ''}`).join('; ');
}
